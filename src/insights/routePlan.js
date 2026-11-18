// A day's visits laid end to end: when to leave home, the drive into each stop,
// when to set off for it, whether it can be reached in time, and when you are
// back.
//
// The stops come from Google Calendar, where visits are booked: every timed
// event with a location. Jobs in Kpital OS are logged once the work is done,
// so a stop with a job at the same address that day counts as done, and an
// older job at that address supplies the customer's name and phone.
//
// Drives are priced with the same Google Routes service the Slot Finder uses,
// in one batch, each leg at the time it would start. Running late carries
// forward: a stop reached after its time starts late and pushes the rest.
import { Entry } from "../models/Entry.js";
import { getDriveMatrix as routesDriveMatrix } from "../services/driveTime.js";
import { listDayEvents, normalizeEvents } from "../services/googleCalendar.js";
import { metresBetween, resolveAddress } from "../services/geoService.js";
import { addDays, addMinutes, chicagoInstant, chicagoTime, formatClock, formatSlotTime } from "../slotFinder/time.js";
import { VISIT_TYPES } from "../constants.js";

const MIN_MINUTES = 15;
// A leg into a stop that has no time yet is priced as if it set off an hour before.
const FIRST_PASS_MINUTES = 60;
// Google Routes prices departures in 15-minute steps (see driveTime.js).
const BUCKET_MS = 15 * 60 * 1000;
// Two places this close (metres) are the same address, however it was typed.
const SAME_PLACE_METRES = 75;
const KNOWN_LOOKUP_LIMIT = 500;

// Street words written the long or the short way, so "Main Street" and
// "Main St" are one street.
const STREET_WORDS = new Map(
  Object.entries({
    street: "st", str: "st", drive: "dr", drv: "dr", avenue: "ave", av: "ave", boulevard: "blvd", road: "rd",
    lane: "ln", court: "ct", circle: "cir", parkway: "pkwy", pky: "pkwy", highway: "hwy", freeway: "fwy",
    place: "pl", terrace: "ter", trail: "trl", square: "sq", expressway: "expy", crossing: "xing",
    north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw"
  })
);
// Everything from a unit marker on is the apartment, not the street.
const UNIT_TAIL = /(\s+(apt|apartment|unit|ste|suite|bldg|building|lot|rm|room|fl|floor)\b.*|\s*#.*)$/;

/**
 * The street line of an address, for matching a calendar location to a job:
 * "123 Main Street, Apt 4, Dallas, TX 75201, USA" and "123 main st" are the same place.
 */
export function streetKey(address) {
  const first = String(address ?? "").split(",")[0].toLowerCase().trim().replace(UNIT_TAIL, "");
  return first
    .replace(/[.]/g, "")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => STREET_WORDS.get(word) ?? word)
    .join(" ");
}

const houseNumber = (key) => /^\d+[a-z]?\b/.exec(key)?.[0] ?? null;

const placed = (point) => Number.isFinite(point?.lat) && Number.isFinite(point?.lng);

// The same place: the street lines agree, or both were placed on the map within a few metres.
function samePlace(stop, job) {
  if (stop.key && stop.key === streetKey(job.customerAddress)) return true;
  const where = { lat: job.addressLat, lng: job.addressLng };
  return placed(stop) && placed(where) && metresBetween(stop, where) <= SAME_PLACE_METRES;
}

async function placeOf(address) {
  try {
    const place = await resolveAddress(address);
    return { lat: place?.lat ?? null, lng: place?.lng ?? null };
  } catch {
    return { lat: null, lng: null };
  }
}

/**
 * The day's visits from the calendar, in time order. Timed events without a
 * location cannot be driven to, so they come back separately as `unrouted`.
 */
export async function calendarStops(accountId, date, { fetchCalendarItems = listDayEvents } = {}) {
  const events = normalizeEvents(await fetchCalendarItems(date)).filter((event) => !event.allDay);
  const located = events.filter((event) => event.location);
  const unrouted = events
    .filter((event) => !event.location)
    .map((event) => ({ title: event.summary || "No title", time: chicagoTime(event.start) }));

  const places = await Promise.all(
    located.map(async (event) => ({ key: streetKey(event.location), ...(await placeOf(event.location)) }))
  );

  // Jobs logged that day: those stops are done.
  const logged = await Entry.find({
    accountId,
    date: new Date(`${date}T00:00:00.000Z`),
    type: { $in: VISIT_TYPES },
    customerAddress: { $gt: "" }
  })
    .select("_id customerAddress addressLat addressLng")
    .lean();

  // Who lives there: the latest job at the same place, found in one query by
  // house number and then matched on the whole street line.
  const numbers = [...new Set(places.map((place) => houseNumber(place.key)).filter(Boolean))];
  const known = numbers.length
    ? await Entry.find({ accountId, customerAddress: { $in: numbers.map((number) => new RegExp(`^\\s*${number}\\b`, "i")) } })
        .sort({ date: -1, createdAt: -1 })
        .limit(KNOWN_LOOKUP_LIMIT)
        .select("customerName customerPhone customerAddress addressLat addressLng")
        .lean()
    : [];

  const stops = located.map((event, index) => {
    const place = places[index];
    const done = logged.find((job) => samePlace(place, job));
    const who = known.find((job) => samePlace(place, job) && (job.customerName || job.customerPhone));
    return {
      _id: `${event.start.toISOString()}|${place.key}`,
      order: index + 1,
      title: event.summary || "No title",
      address: event.location,
      scheduledTime: chicagoTime(event.start),
      minutes: Math.max(MIN_MINUTES, Math.round((event.end - event.start) / 60000)),
      entryId: done ? String(done._id) : null,
      customerName: who?.customerName || "",
      customerPhone: who?.customerPhone || "",
      lat: place.lat,
      lng: place.lng
    };
  });
  return { stops, unrouted };
}

const clock = (instant) => (instant ? formatClock(instant) : null);
const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000);
const later = (a, b) => (a > b ? a : b);

/**
 * Lays the day out from the drive times. drives[i] is the leg into stop i
 * (from home for the first); drives[stops.length] is the way home.
 *
 * Per stop: `leaveBy` is when to set off from the place before to be there
 * with the buffer to spare; `spareMin` is how early you would arrive (negative
 * when late); `lateByMin` is how late, counted from the booked time. A late
 * arrival starts the visit late, so everything after it moves too.
 */
export function planDay({ date, stops, homeBase, bufferMinutes = 0, homeBy = "", drives }) {
  const warnings = [];
  const planned = [];
  let previousEnd = null;
  let leaveHomeBy = null;
  let totalDrive = 0;

  stops.forEach((stop, index) => {
    const leg = drives[index];
    const driveIn = leg && !leg.unreachable ? leg.minutes : null;
    if (driveIn === null && drives.length) warnings.push(`Could not work out the drive to stop ${stop.order} (${stop.address}).`);
    if (driveIn !== null) totalDrive += driveIn;

    const booked = stop.scheduledTime ? chicagoInstant(date, stop.scheduledTime) : null;
    const arriveAt = previousEnd && driveIn !== null ? addMinutes(previousEnd, driveIn) : null;
    const leaveBy = booked && driveIn !== null ? addMinutes(booked, -(driveIn + bufferMinutes)) : null;
    if (index === 0) leaveHomeBy = leaveBy;

    let lateBy = 0;
    let spare = null;
    if (booked && arriveAt) {
      spare = minutesBetween(arriveAt, booked);
      const when = `Stop ${stop.order} at ${formatSlotTime(stop.scheduledTime)}`;
      if (spare < 0) {
        lateBy = -spare;
        warnings.push(`${when}: you would get there about ${lateBy} min late.`);
      } else if (spare < bufferMinutes) {
        warnings.push(`${when}: only ${spare} min to spare, under your ${bufferMinutes}-minute buffer.`);
      }
    }
    // A late arrival starts late; without a booked time the visit starts on arrival.
    const startAt = booked && arriveAt ? later(booked, arriveAt) : booked ?? arriveAt;
    const endAt = startAt ? addMinutes(startAt, stop.minutes) : null;
    planned.push({
      ...stop,
      driveInMin: driveIn,
      leaveBy: clock(leaveBy),
      arriveAt: clock(arriveAt),
      startAt: clock(startAt),
      endAt: clock(endAt),
      spareMin: spare,
      lateByMin: lateBy
    });
    previousEnd = endAt;
  });

  const homeLeg = drives[stops.length];
  const driveHome = homeLeg && !homeLeg.unreachable ? homeLeg.minutes : null;
  if (driveHome !== null) totalDrive += driveHome;
  const homeAt = previousEnd && driveHome !== null ? addMinutes(previousEnd, driveHome) : null;
  if (homeAt && homeBy) {
    const limit = chicagoInstant(homeBy < "05:00" ? addDays(date, 1) : date, homeBy);
    if (homeAt > limit) warnings.push(`You would be home around ${formatClock(homeAt)}, after your ${formatSlotTime(homeBy)} limit.`);
  }
  if (stops.length && !stops[0].scheduledTime) warnings.push("The first stop has no time, so there is no leave-home time.");

  return {
    date,
    homeBase,
    leaveHomeBy: clock(leaveHomeBy),
    stops: planned,
    driveHomeMin: driveHome,
    homeAt: clock(homeAt),
    totalDriveMin: totalDrive,
    warnings
  };
}

const sameBucket = (a, b) => Math.floor(a.getTime() / BUCKET_MS) === Math.floor(b.getTime() / BUCKET_MS);

/**
 * Prices every leg of the given stops in one batch and lays the day out.
 *
 * Each leg is priced at the time it would set off: from the stop before as it
 * ends when that stop has a time, otherwise an hour before the stop it leads
 * to. The first leg is then priced once more at the real leave-home time when
 * that falls in a different 15-minute window, so rush hour is not missed.
 */
export async function routePlan({ date, stops, settings, now = new Date() }, { getDriveMatrix = routesDriveMatrix } = {}) {
  const { homeBase, bufferMinutes, homeBy } = settings;
  if (stops.length === 0) return planDay({ date, stops, homeBase, bufferMinutes, homeBy, drives: [] });

  const at = (stop) => (stop?.scheduledTime ? chicagoInstant(date, stop.scheduledTime) : null);
  const legs = stops.map((stop, index) => {
    const before = stops[index - 1];
    const from = before ? before.address : homeBase;
    const departAt = before && at(before)
      ? addMinutes(at(before), before.minutes)
      : at(stop)
        ? addMinutes(at(stop), -FIRST_PASS_MINUTES)
        : now;
    return { from, to: stop.address, departAt };
  });
  const last = stops[stops.length - 1];
  legs.push({ from: last.address, to: homeBase, departAt: at(last) ? addMinutes(at(last), last.minutes) : now });

  const drives = await getDriveMatrix(legs, { now });

  const first = drives[0];
  const firstStart = at(stops[0]);
  if (firstStart && first && !first.unreachable) {
    const leaveAt = addMinutes(firstStart, -(first.minutes + (bufferMinutes || 0)));
    if (leaveAt > now && !sameBucket(leaveAt, legs[0].departAt)) {
      const [again] = await getDriveMatrix([{ ...legs[0], departAt: leaveAt }], { now });
      if (again && !again.unreachable) drives[0] = again;
    }
  }
  return planDay({ date, stops, homeBase, bufferMinutes, homeBy, drives });
}
