// The Slot Finder: which fixed slots can honestly be offered to a customer at
// an address on a date, given the bookings in Google Calendar and live-traffic
// drive times. Used by GET/POST /api/slot-finder, and through that by the
// find_slots MCP tool.
//
// Steps (all times America/Chicago):
//  1. Past date: answer "past_date" with no Google calls.
//  2. Drop slots that already started (today) or overlap any busy event.
//  3. Round 0: one call from home base to the customer and to every booking
//     location. A customer that cannot be reached is a 400; a booking that
//     cannot be reached is kept as a time block only, with a warning.
//  4. For each slot, PREV is the located event ending last at or before the
//     start (or home base) and NEXT the located event(s) starting first at or
//     after the end.
//  5. Round 1: drive in from PREV, drive out to each NEXT. Round 2: re-price a
//     home leg at the time the owner would actually leave.
//  6. Offer a slot only if the drive in and the drive out both fit with the
//     buffer, and, today, the owner can still leave home in time.
import { getDriveMatrix as routesDriveMatrix, normalizeAddress } from "../services/driveTime.js";
import { listDayEvents, normalizeEvents } from "../services/googleCalendar.js";
import { BAD_ADDRESS_MESSAGE, SlotFinderError } from "./errors.js";
import { buildMessages, dayLabel } from "./messages.js";
import { addMinutes, chicagoDateString, chicagoInstant, formatClock, formatSlotTime } from "./time.js";

// The first-pass home leg is priced as if leaving an hour before the slot.
const HOME_FIRST_PASS_MINUTES = 60;

const overlaps = (event, start, end) => event.start < end && event.end > start;

// The located event with the latest end at or before the slot start; on a tie,
// the one that started later.
function previousEvent(located, slotStart) {
  let best = null;
  for (const event of located) {
    if (event.end > slotStart) continue;
    if (!best || event.end > best.end || (event.end.getTime() === best.end.getTime() && event.start > best.start)) {
      best = event;
    }
  }
  return best;
}

// Every located event sharing the earliest start at or after the slot end.
function nextEvents(located, slotEnd) {
  let earliest = null;
  for (const event of located) {
    if (event.start >= slotEnd && (earliest === null || event.start < earliest)) earliest = event.start;
  }
  return earliest === null ? [] : located.filter((event) => event.start.getTime() === earliest.getTime());
}

export async function findSlots(
  { date, address, durationMinutes, settings, now = new Date() },
  { fetchCalendarItems = listDayEvents, getDriveMatrix = routesDriveMatrix } = {}
) {
  const today = chicagoDateString(now);
  const { bufferMinutes: buffer, homeBase } = settings;
  const customer = address;
  const warnings = [];

  const respond = (state, offered) => {
    const { messageEn, messageEs } = buildMessages({
      starts: offered.map((slot) => slot.start),
      date,
      today,
      templates: settings.messageTemplates
    });
    return {
      date,
      dayLabel: dayLabel(date, today, "en"),
      state,
      slots: offered,
      warnings,
      messageEn,
      messageEs,
      durationMinutes
    };
  };

  if (date < today) return respond("past_date", []);

  let candidates = settings.slotStarts.map((start) => {
    const at = chicagoInstant(date, start);
    return { start, at, end: addMinutes(at, durationMinutes) };
  });
  // A start time that has already gone is never offered.
  if (date === today) candidates = candidates.filter((slot) => slot.at > now);
  if (candidates.length === 0) return respond("no_slots", []);

  const events = normalizeEvents(await fetchCalendarItems(date));
  candidates = candidates.filter((slot) => !events.some((event) => overlaps(event, slot.at, slot.end)));
  if (candidates.length === 0) return respond("no_slots", []);

  // Round 0: is the customer reachable, and which bookings can be routed to?
  const locations = new Map();
  for (const event of events) {
    if (!event.location) continue;
    const key = normalizeAddress(event.location);
    if (!locations.has(key)) locations.set(key, event.location);
  }
  const locationKeys = [...locations.keys()];
  const round0 = await getDriveMatrix(
    [customer, ...locations.values()].map((to) => ({ from: homeBase, to, departAt: now })),
    { now }
  );
  if (round0[0].unreachable) throw new SlotFinderError(BAD_ADDRESS_MESSAGE, 400);

  const unroutable = new Set(locationKeys.filter((_, index) => round0[index + 1].unreachable));
  for (const event of events) {
    if (event.location && unroutable.has(normalizeAddress(event.location))) {
      warnings.push(
        `Could not route to the ${formatClock(event.start)} booking (${event.summary || "No title"}), so it was treated as a time block only.`
      );
    }
  }
  // Events with no location, or one that cannot be routed, still block their
  // time (above) but are never PREV or NEXT.
  const located = events.filter((event) => event.location && !unroutable.has(normalizeAddress(event.location)));

  // Round 1: drive in from PREV (or home), drive out to every NEXT.
  const legs = [];
  const plans = candidates.map((slot) => {
    const prev = previousEvent(located, slot.at);
    const next = nextEvents(located, slot.end);
    const inLeg =
      legs.push(
        prev
          ? { from: prev.location, to: customer, departAt: prev.end }
          : { from: homeBase, to: customer, departAt: addMinutes(slot.at, -HOME_FIRST_PASS_MINUTES) }
      ) - 1;
    const outLegs = next.map((event) => legs.push({ from: customer, to: event.location, departAt: slot.end }) - 1);
    return { ...slot, prev, next, inLeg, outLegs, unreachable: false };
  });
  const round1 = await getDriveMatrix(legs, { now });

  for (const plan of plans) {
    const results = [round1[plan.inLeg], ...plan.outLegs.map((index) => round1[index])];
    if (results.some((result) => result.unreachable)) {
      plan.unreachable = true;
      continue;
    }
    plan.driveIn = round1[plan.inLeg].minutes;
    const outMinutes = plan.outLegs.map((index) => round1[index].minutes);
    plan.driveOut = outMinutes.length ? Math.max(...outMinutes) : null;
    plan.outFits = plan.next.every(
      (event, i) => addMinutes(plan.end, outMinutes[i] + buffer) <= event.start
    );
    plan.inFits = plan.prev ? addMinutes(plan.prev.end, plan.driveIn + buffer) <= plan.at : true;
  }

  // Round 2: a home leg priced at an hour before the slot can miss rush hour.
  // Re-price it once at the time the owner would leave, for slots still in play.
  const refine = plans.filter((plan) => !plan.prev && !plan.unreachable && plan.outFits);
  if (refine.length > 0) {
    const round2 = await getDriveMatrix(
      refine.map((plan) => ({
        from: homeBase,
        to: customer,
        departAt: addMinutes(plan.at, -(plan.driveIn + buffer))
      })),
      { now }
    );
    refine.forEach((plan, index) => {
      if (round2[index].unreachable) {
        plan.unreachable = true;
        return;
      }
      plan.driveIn = round2[index].minutes;
      plan.leaveHomeBy = addMinutes(plan.at, -(plan.driveIn + buffer));
    });
  }

  const offered = [];
  for (const plan of plans) {
    if (plan.unreachable) {
      warnings.push(`Could not calculate the drive for the ${formatSlotTime(plan.start)} slot, so it was not offered.`);
      continue;
    }
    if (!plan.outFits || !plan.inFits) continue;
    // From home the drive is never too long, but today the owner must still be
    // able to leave in time.
    if (!plan.prev && date === today && plan.leaveHomeBy < now) continue;
    offered.push({
      start: plan.start,
      driveInMin: plan.driveIn,
      driveOutMin: plan.driveOut,
      leaveHomeBy: plan.prev ? null : formatClock(plan.leaveHomeBy)
    });
  }

  return respond(offered.length > 0 ? "ok" : "no_slots", offered);
}
