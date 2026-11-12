// Drive times between addresses, from the Google Routes API (Compute Route
// Matrix, traffic-aware). Nothing else in the Slot Finder calls Google Routes,
// so the provider can be swapped here without touching the slot logic.
//
// getDriveMatrix(legs) takes { from, to, departAt } legs and answers, in the
// same order, { minutes } or { unreachable: true } for each. Inside it:
//  - departAt is floored to its 15-minute bucket and moved to at least
//    now + 2 minutes, because Google only prices future departures for driving;
//  - identical legs (same addresses, same departure sent) are asked once;
//  - legs are grouped by the departure sent, and each group is asked in as few
//    calls as possible: the address shared by the most legs on one side is the
//    hub of a call (many origins into it, or it out to many destinations). With
//    the customer on one side of every leg that is at most two calls, "into the
//    customer" and "out of the customer"; for the round 0 check it is one call
//    out of home base.
import { SlotFinderError, missingEnv } from "../slotFinder/errors.js";

const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const FIELD_MASK = "originIndex,destinationIndex,duration,staticDuration,condition,status";
const BUCKET_MS = 15 * 60 * 1000;
const MIN_LEAD_MS = 2 * 60 * 1000;
// Routes API limits with TRAFFIC_AWARE_OPTIMAL: 100 elements per call, and at
// most 50 origins + destinations given as addresses. A hub call is one address
// plus its spokes, so 49 spokes at most.
const MAX_ADDRESS_WAYPOINTS = 50;
const MAX_ELEMENTS = 100;
const MAX_SPOKES = Math.min(MAX_ADDRESS_WAYPOINTS - 1, MAX_ELEMENTS);
const REQUEST_TIMEOUT_MS = 10000;
const ROUTES_FAILED = "Google Routes request failed.";
// The project caps drive pairs per day to keep the bill small; Google answers
// 429 once it is used up, and the quota resets at midnight Pacific.
const DAILY_LIMIT_REACHED =
  "Google Routes request failed: today's drive-time limit is used up. It resets at 2:00 AM Houston time.";

const UNREACHABLE = Object.freeze({ unreachable: true });

// Answers are remembered for a few minutes, keyed by the two addresses and the
// 15-minute window of the departure. Looking at another day, or searching the
// same address again while on the phone with the customer, then costs none of
// the day's drive-time allowance. Kept in memory: it only has to outlive a
// conversation, and a restart simply asks Google again.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 500;
const cache = new Map();
const cacheOn = () => process.env.DRIVE_CACHE !== "off";

export function clearDriveCache() {
  cache.clear();
}

function cacheKeyOf(leg) {
  const bucket = Math.floor(new Date(leg.departureTime).getTime() / BUCKET_MS);
  return `${leg.fromKey}\n${leg.toKey}\n${bucket}`;
}

function remembered(leg, now) {
  const hit = cache.get(cacheKeyOf(leg));
  if (!hit) return null;
  if (now.getTime() - hit.at > CACHE_TTL_MS) {
    cache.delete(cacheKeyOf(leg));
    return null;
  }
  return hit.result;
}

function remember(leg, now) {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(cacheKeyOf(leg), { result: leg.result, at: now.getTime() });
}

export function normalizeAddress(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function cleanAddress(text) {
  return String(text ?? "").trim().replace(/\s+/g, " ");
}

// The departure time sent to Google for a leg: its 15-minute bucket, but never
// earlier than now + 2 minutes. Only the traffic estimate uses this; the slot
// arithmetic keeps the real times.
export function sentDepartureTime(departAt, now = new Date()) {
  const bucketed = Math.floor(departAt.getTime() / BUCKET_MS) * BUCKET_MS;
  return new Date(Math.max(bucketed, now.getTime() + MIN_LEAD_MS));
}

// "1234s" -> 21 (whole minutes, rounded up).
export function durationToMinutes(value) {
  const match = /^(\d+(?:\.\d+)?)s$/.exec(String(value ?? ""));
  return match ? Math.ceil(Number(match[1]) / 60) : null;
}

function elementResult(element) {
  if (!element) return UNREACHABLE;
  if (element.condition === "ROUTE_NOT_FOUND") return UNREACHABLE;
  if (element.status && Number(element.status.code || 0) !== 0) return UNREACHABLE;
  const minutes = durationToMinutes(element.duration ?? element.staticDuration);
  if (minutes !== null) return { minutes };
  // A route that exists with no duration is zero seconds long (proto JSON
  // leaves zero values out).
  return element.condition === "ROUTE_EXISTS" ? { minutes: 0 } : UNREACHABLE;
}

async function postMatrix(body, apiKey) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": FIELD_MASK
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
  } catch {
    throw new SlotFinderError(ROUTES_FAILED, 502);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => null);
  if (response.status === 400) {
    const error = Array.isArray(data) ? data[0]?.error : data?.error;
    if (error?.status === "INVALID_ARGUMENT") return { invalidArgument: true };
  }
  if (response.status === 429) throw new SlotFinderError(DAILY_LIMIT_REACHED, 502);
  if (!response.ok || !Array.isArray(data)) throw new SlotFinderError(ROUTES_FAILED, 502);
  return { elements: data };
}

// Asks one hub call and writes each leg's result onto it.
async function runCall(call, apiKey) {
  const { hub, legs, departureTime } = call;
  const waypoint = (address) => ({ waypoint: { address } });
  const intoHub = hub === "to";
  const body = {
    origins: intoHub ? legs.map((leg) => waypoint(leg.from)) : [waypoint(legs[0].from)],
    destinations: intoHub ? [waypoint(legs[0].to)] : legs.map((leg) => waypoint(leg.to)),
    travelMode: "DRIVE",
    routingPreference: "TRAFFIC_AWARE_OPTIMAL",
    departureTime
  };

  const answer = await postMatrix(body, apiKey);
  if (answer.invalidArgument) {
    if (legs.length === 1) {
      legs[0].result = UNREACHABLE;
      return;
    }
    // One address Google cannot read fails the whole call. Ask each leg alone
    // so only the bad one is marked unreachable.
    await Promise.all(legs.map((leg) => runCall({ hub, legs: [leg], departureTime }, apiKey)));
    return;
  }

  // Elements can arrive in any order; zero indexes may be left out.
  const byIndex = new Map();
  for (const element of answer.elements) {
    const spoke = intoHub ? Number(element?.originIndex || 0) : Number(element?.destinationIndex || 0);
    const hubIndex = intoHub ? Number(element?.destinationIndex || 0) : Number(element?.originIndex || 0);
    if (hubIndex === 0) byIndex.set(spoke, element);
  }
  legs.forEach((leg, index) => {
    leg.result = elementResult(byIndex.get(index));
  });
}

// Splits one departure group into hub calls.
function planCalls(legs, departureTime) {
  const calls = [];
  const remaining = new Set(legs);
  while (remaining.size > 0) {
    const counts = new Map();
    for (const leg of remaining) {
      for (const key of [`to\n${leg.toKey}`, `from\n${leg.fromKey}`]) counts.set(key, (counts.get(key) || 0) + 1);
    }
    let best = null;
    for (const [key, count] of counts) if (!best || count > best.count) best = { key, count };
    const [hub, address] = best.key.split("\n");
    const members = [...remaining].filter((leg) => (hub === "to" ? leg.toKey : leg.fromKey) === address);
    for (const leg of members) remaining.delete(leg);
    for (let i = 0; i < members.length; i += MAX_SPOKES) {
      calls.push({ hub, legs: members.slice(i, i + MAX_SPOKES), departureTime });
    }
  }
  return calls;
}

export async function getDriveMatrix(legs, { now = new Date() } = {}) {
  if (!Array.isArray(legs) || legs.length === 0) return [];
  const apiKey = String(process.env.GOOGLE_MAPS_API_KEY || "").trim();
  if (!apiKey) throw missingEnv("GOOGLE_MAPS_API_KEY");

  const unique = new Map();
  const keys = legs.map((leg) => {
    const fromKey = normalizeAddress(leg.from);
    const toKey = normalizeAddress(leg.to);
    const departureTime = sentDepartureTime(leg.departAt, now).toISOString();
    const key = `${fromKey}\n${toKey}\n${departureTime}`;
    if (!unique.has(key)) {
      unique.set(key, {
        from: cleanAddress(leg.from),
        to: cleanAddress(leg.to),
        fromKey,
        toKey,
        departureTime,
        // A leg with a blank end cannot be routed; it is never sent.
        result: fromKey && toKey ? null : UNREACHABLE
      });
    }
    return key;
  });

  const asked = [];
  const groups = new Map();
  for (const leg of unique.values()) {
    if (leg.result) continue;
    if (cacheOn()) {
      leg.result = remembered(leg, now);
      if (leg.result) continue;
    }
    asked.push(leg);
    if (!groups.has(leg.departureTime)) groups.set(leg.departureTime, []);
    groups.get(leg.departureTime).push(leg);
  }

  const calls = [...groups].flatMap(([departureTime, group]) => planCalls(group, departureTime));
  await Promise.all(calls.map((call) => runCall(call, apiKey)));
  // Only what Google answered is kept; a failed request throws before this.
  if (cacheOn()) for (const leg of asked) if (leg.result) remember(leg, now);

  return keys.map((key) => {
    const { result } = unique.get(key);
    return result && !result.unreachable ? { minutes: result.minutes } : { unreachable: true };
  });
}

export async function getDriveMinutes(fromAddress, toAddress, departAtDate, options) {
  const [result] = await getDriveMatrix([{ from: fromAddress, to: toAddress, departAt: departAtDate }], options);
  if (result.unreachable) throw new SlotFinderError("No drivable route was found between those addresses.", 400);
  return result.minutes;
}
