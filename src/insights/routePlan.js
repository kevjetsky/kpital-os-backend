// A day's visits laid end to end: when to leave home, the drive into each stop,
// whether it can be reached in time, and when you are back.
//
// Drives are priced with the same Google Routes service the Slot Finder uses,
// in one batch, each leg at the time it would start. A stop with an
// appointment time keeps it; a stop without one starts as soon as you get there.
import { Entry } from "../models/Entry.js";
import { getDriveMatrix as routesDriveMatrix } from "../services/driveTime.js";
import { addMinutes, chicagoInstant, formatClock, formatSlotTime } from "../slotFinder/time.js";

const VISIT_TYPES = ["Repair", "Sales"];
const DEFAULT_MINUTES = 60;
// A leg into a stop that has no time yet is priced as if it set off an hour before.
const FIRST_PASS_MINUTES = 60;

/** The day's visits in order: appointment time first, earliest first, then the rest as booked. */
export async function dayStops(accountId, date) {
  const jobs = await Entry.find({
    accountId,
    date: new Date(`${date}T00:00:00.000Z`),
    type: { $in: VISIT_TYPES },
    customerAddress: { $gt: "" }
  })
    .select("_id scheduledTime scheduledMinutes customerAddress createdAt jobStatus status")
    .lean();
  const timed = jobs.filter((job) => job.scheduledTime).sort((a, b) => a.scheduledTime.localeCompare(b.scheduledTime));
  const untimed = jobs.filter((job) => !job.scheduledTime).sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return [...timed, ...untimed].map((job, index) => ({
    _id: String(job._id),
    order: index + 1,
    address: job.customerAddress.trim(),
    scheduledTime: job.scheduledTime || "",
    minutes: job.scheduledMinutes || DEFAULT_MINUTES
  }));
}

const clock = (instant) => (instant ? formatClock(instant) : null);
const minutesBetween = (a, b) => Math.round((b.getTime() - a.getTime()) / 60000);

export function planDay({ date, stops, homeBase, bufferMinutes = 0, homeBy = "", drives }) {
  // drives[i] is the leg into stop i (from home for the first); drives[stops.length] the way home.
  const warnings = [];
  const planned = [];
  let previousEnd = null;
  let leaveHomeBy = null;
  let totalDrive = 0;

  stops.forEach((stop, index) => {
    const leg = drives[index];
    const driveIn = leg && !leg.unreachable ? leg.minutes : null;
    if (driveIn === null) warnings.push(`Could not work out the drive to stop ${stop.order} (${stop.address}).`);
    else totalDrive += driveIn;

    const booked = stop.scheduledTime ? chicagoInstant(date, stop.scheduledTime) : null;
    const arriveAt = previousEnd && driveIn !== null ? addMinutes(previousEnd, driveIn) : null;
    let lateBy = 0;
    if (index === 0 && booked && driveIn !== null) leaveHomeBy = addMinutes(booked, -(driveIn + bufferMinutes));
    if (booked && arriveAt) {
      const short = minutesBetween(booked, addMinutes(arriveAt, bufferMinutes));
      if (short > 0) {
        lateBy = short;
        warnings.push(`Stop ${stop.order} at ${formatSlotTime(stop.scheduledTime)}: you would get there about ${short} min late.`);
      }
    }
    const startAt = booked ?? arriveAt;
    const endAt = startAt ? addMinutes(startAt, stop.minutes) : null;
    planned.push({
      ...stop,
      driveInMin: driveIn,
      arriveAt: clock(arriveAt),
      startAt: clock(startAt),
      endAt: clock(endAt),
      lateByMin: lateBy
    });
    previousEnd = endAt;
  });

  const homeLeg = drives[stops.length];
  const driveHome = homeLeg && !homeLeg.unreachable ? homeLeg.minutes : null;
  if (driveHome !== null) totalDrive += driveHome;
  const homeAt = previousEnd && driveHome !== null ? addMinutes(previousEnd, driveHome) : null;
  if (homeAt && homeBy) {
    const limit = chicagoInstant(homeBy < "05:00" ? nextDay(date) : date, homeBy);
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

function nextDay(date) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
}

/** Prices every leg in one batch and lays the day out. */
export async function routePlan({ accountId, date, settings, now = new Date() }, { getDriveMatrix = routesDriveMatrix } = {}) {
  const stops = await dayStops(accountId, date);
  const { homeBase, bufferMinutes, homeBy } = settings;
  if (stops.length === 0) return planDay({ date, stops, homeBase, bufferMinutes, homeBy, drives: [] });

  // Each leg is priced at the time it would set off: from the stop before as it
  // ends when that stop has a time, otherwise an hour before the stop it leads to.
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
  return planDay({ date, stops, homeBase, bufferMinutes, homeBy, drives });
}
