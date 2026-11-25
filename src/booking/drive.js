// Drive times for the booking page: the Slot Finder's Google Routes matrix,
// priced for a "typical day" and capped per day.
//
// The booking page checks a whole week for every customer. Asked as-is, each
// day's legs leave on a different date, so nothing repeats and a single
// customer would cost hundreds of Routes elements. Instead every leg is priced
// as if it left at the same time of day tomorrow: the seven days then share
// answers (the same places at the same hours), and a new customer costs a few
// dozen elements. The slot arithmetic keeps the real times; only the traffic
// forecast is borrowed from tomorrow.
//
// What is not already known is counted against BOOKING_MAPS_DAILY_CAP before
// it is asked, because the booking page shares the Google project's daily
// Routes limit with the Slot Finder.
import { getDriveMatrix, normalizeAddress } from "../services/driveTime.js";
import { SlotFinderError } from "../slotFinder/errors.js";
import { addDays, chicagoDateString, chicagoInstant, chicagoTime } from "../slotFinder/time.js";
import { spendRoutes } from "./store.js";

const BUCKET_MS = 15 * 60 * 1000;
const TTL_MS = 3 * 60 * 60 * 1000;
const CACHE_MAX = 3000;
const cache = new Map();

export function clearBookingDriveCache() {
  cache.clear();
}

export class RoutesBudgetError extends SlotFinderError {
  constructor() {
    super("The booking page used up today's drive-time allowance.", 503);
    this.code = "maps_budget";
  }
}

function remembered(key, nowMs) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (hit.expiresAt < nowMs) {
    cache.delete(key);
    return null;
  }
  return hit.result;
}

function remember(key, result, nowMs) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { result, expiresAt: nowMs + TTL_MS });
}

// A getDriveMatrix(legs, { now }) for findSlots.
export function makeBookingDrive({ config, now }) {
  const typicalDay = addDays(chicagoDateString(now), 1);
  const typical = (departAt) => chicagoInstant(typicalDay, chicagoTime(new Date(departAt)));

  return async function bookingDriveMatrix(legs) {
    const nowMs = now.getTime();
    const prepared = legs.map((leg) => {
      const departAt = typical(leg.departAt);
      const key = `${normalizeAddress(leg.from)}\n${normalizeAddress(leg.to)}\n${Math.floor(departAt.getTime() / BUCKET_MS)}`;
      return { leg: { from: leg.from, to: leg.to, departAt }, key, hit: remembered(key, nowMs) };
    });

    const missing = new Map();
    for (const item of prepared) {
      if (item.hit || missing.has(item.key)) continue;
      if (!normalizeAddress(item.leg.from) || !normalizeAddress(item.leg.to)) continue;
      // The same place at both ends is no drive; Google is not asked.
      if (normalizeAddress(item.leg.from) === normalizeAddress(item.leg.to)) {
        item.hit = { minutes: 0 };
        continue;
      }
      missing.set(item.key, item.leg);
    }

    if (missing.size > 0) {
      if (!(await spendRoutes(chicagoDateString(now), missing.size, config.mapsDailyCap))) throw new RoutesBudgetError();
      const keys = [...missing.keys()];
      const answers = await getDriveMatrix([...missing.values()], { now });
      keys.forEach((key, index) => remember(key, answers[index], nowMs));
    }

    return prepared.map((item) => {
      if (item.hit) return item.hit;
      if (!normalizeAddress(item.leg.from) || !normalizeAddress(item.leg.to)) return { unreachable: true };
      return remembered(item.key, nowMs) || { unreachable: true };
    });
  };
}
