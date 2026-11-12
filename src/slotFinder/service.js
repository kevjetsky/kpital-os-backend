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
//  7. A slot with nothing booked after it is the day's last job: the drive home
//     is priced too, and the slot is dropped if it would end the day after the
//     owner's "home by" time.
//  8. The offered slot with the least driving around it is marked recommended.
import { getDriveMatrix as routesDriveMatrix, normalizeAddress } from "../services/driveTime.js";
import { listDayEvents, normalizeEvents } from "../services/googleCalendar.js";
import { BAD_ADDRESS_MESSAGE, SlotFinderError } from "./errors.js";
import { buildMessages, dayLabel, joinTimes } from "./messages.js";
import { addDays, addMinutes, chicagoDateString, chicagoInstant, formatClock, formatSlotTime } from "./time.js";

// The first-pass home leg is priced as if leaving an hour before the slot.
const HOME_FIRST_PASS_MINUTES = 60;

const overlaps = (event, start, end) => event.start < end && event.end > start;

const noBookedJobs = async () => [];

// The day's bookings: Google Calendar's, plus jobs booked in the app with a time.
async function dayEvents(date, fetchCalendarItems, fetchBookedJobs) {
  const [items, jobs] = await Promise.all([fetchCalendarItems(date), fetchBookedJobs(date)]);
  return [...normalizeEvents(items), ...jobs].sort((a, b) => a.start - b.start || a.end - b.end);
}

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
  { fetchCalendarItems = listDayEvents, getDriveMatrix = routesDriveMatrix, fetchBookedJobs = noBookedJobs } = {}
) {
  const today = chicagoDateString(now);
  const { bufferMinutes: buffer, homeBase } = settings;
  const customer = address;
  const warnings = [];
  let farAway = null;

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
      farAway,
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

  const events = await dayEvents(date, fetchCalendarItems, fetchBookedJobs);
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
  if (settings.farDriveMinutes > 0 && round0[0].minutes > settings.farDriveMinutes) {
    farAway = { driveMinutes: round0[0].minutes, limitMinutes: settings.farDriveMinutes };
    warnings.push(
      `This address is about ${round0[0].minutes} minutes from home base, over your ${settings.farDriveMinutes}-minute mark. Consider a travel fee.`
    );
  }

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
    // Nothing located after it: this would be the last job, so price the way home.
    const homeLeg = next.length === 0 ? legs.push({ from: customer, to: homeBase, departAt: slot.end }) - 1 : null;
    return { ...slot, prev, next, inLeg, outLegs, homeLeg, unreachable: false };
  });
  const round1 = await getDriveMatrix(legs, { now });

  for (const plan of plans) {
    const results = [round1[plan.inLeg], ...plan.outLegs.map((index) => round1[index])];
    if (plan.homeLeg !== null) results.push(round1[plan.homeLeg]);
    if (results.some((result) => result.unreachable)) {
      plan.unreachable = true;
      continue;
    }
    plan.driveIn = round1[plan.inLeg].minutes;
    const outMinutes = plan.outLegs.map((index) => round1[index].minutes);
    plan.driveOut = outMinutes.length ? Math.max(...outMinutes) : null;
    plan.driveHome = plan.homeLeg !== null ? round1[plan.homeLeg].minutes : null;
    plan.homeAt = plan.driveHome !== null ? addMinutes(plan.end, plan.driveHome) : null;
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

  const homeByInstant = settings.homeBy ? chicagoInstant(homeByDate(date, settings), settings.homeBy) : null;
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
    if (homeByInstant && plan.homeAt && plan.homeAt > homeByInstant) {
      warnings.push(
        `The ${formatSlotTime(plan.start)} slot was not offered: it would get you home around ${formatClock(plan.homeAt)}, after your ${formatSlotTime(settings.homeBy)} limit.`
      );
      continue;
    }
    offered.push({
      start: plan.start,
      driveInMin: plan.driveIn,
      driveOutMin: plan.driveOut,
      leaveHomeBy: plan.prev ? null : formatClock(plan.leaveHomeBy),
      driveHomeMin: plan.driveHome,
      homeAt: plan.homeAt ? formatClock(plan.homeAt) : null,
      // All the driving this slot adds around it: in, then on to the next job or home.
      driveTotalMin: plan.driveIn + (plan.driveOut ?? plan.driveHome ?? 0),
      recommended: false
    });
  }

  // With a choice to make, point at the slot that costs the least driving.
  if (offered.length > 1) {
    const least = Math.min(...offered.map((slot) => slot.driveTotalMin));
    if (offered.some((slot) => slot.driveTotalMin > least)) {
      offered.find((slot) => slot.driveTotalMin === least).recommended = true;
    }
  }

  return respond(offered.length > 0 ? "ok" : "no_slots", offered);
}

// "Home by" times after midnight (before 5 AM) belong to the following morning.
function homeByDate(date, settings) {
  return settings.homeBy < "05:00" ? addDays(date, 1) : date;
}

const MAX_SEARCH_DAYS = 3;
const UPCOMING_DAYS = 4;

// Several days in one answer.
//
// `days` (1 to 3) are checked in full, drive times included, starting at
// `date`. The days after those are only looked up in the calendar, which costs
// no drive-time quota: each says how many slot times are still free of
// bookings, so the owner can see where the openings are before spending a full
// check on a day.
//
// The first day's answer stays at the top level, so callers that ask for one
// day read exactly what they always did.
export async function searchDays(
  { date, days = 1, address, durationMinutes, settings, now = new Date() },
  deps = {}
) {
  const { fetchCalendarItems = listDayEvents, fetchBookedJobs = noBookedJobs } = deps;
  const today = chicagoDateString(now);
  const count = Math.min(Math.max(1, days), MAX_SEARCH_DAYS);

  const results = [];
  for (let offset = 0; offset < count; offset += 1) {
    results.push(await findSlots({ date: addDays(date, offset), address, durationMinutes, settings, now }, deps));
  }

  // A past date gets its plain answer and nothing else is looked up.
  const firstUpcoming = addDays(date, count);
  const upcoming = firstUpcoming <= today ? [] : await Promise.all(
    Array.from({ length: UPCOMING_DAYS }, (_, index) => addDays(firstUpcoming, index)).map(async (day) => {
      const events = await dayEvents(day, fetchCalendarItems, fetchBookedJobs);
      const free = settings.slotStarts.filter((start) => {
        const at = chicagoInstant(day, start);
        return at > now && !events.some((event) => overlaps(event, at, addMinutes(at, durationMinutes)));
      });
      return { date: day, dayLabel: dayLabel(day, today, "en"), freeSlots: free.length, starts: free };
    })
  );

  const lines = (language) =>
    results
      .filter((result) => result.slots.length > 0)
      .map((result) => {
        const label = dayLabel(result.date, today, language);
        const times = joinTimes(result.slots.map((slot) => formatSlotTime(slot.start)), language);
        return `${label.charAt(0).toUpperCase()}${label.slice(1)}: ${times}`;
      })
      .join("\n");

  return {
    ...results[0],
    days: results.map(({ date: day, dayLabel: label, state, slots, farAway, warnings, messageEn, messageEs }) => ({
      date: day, dayLabel: label, state, slots, farAway, warnings, messageEn, messageEs
    })),
    // One line per day with openings, for a reply that covers them all.
    summaryEn: lines("en") || null,
    summaryEs: lines("es") || null,
    upcoming
  };
}
