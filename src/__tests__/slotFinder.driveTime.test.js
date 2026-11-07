// Acceptance test 16: the driveTime module against a mocked fetch (the real
// module, with Google's Routes API faked at the HTTP level).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { durationToMinutes, getDriveMatrix, getDriveMinutes, sentDepartureTime } from "../services/driveTime.js";
import { chicagoInstant } from "../slotFinder/time.js";

const FRIDAY = "2026-11-06";
const at = (time) => chicagoInstant(FRIDAY, time);
const NOW = at("06:00");
const HOME = "11822 Bandlon Dr, Houston, TX 77072";
const CUSTOMER = "2524 Chamberlain St, Houston, TX 77093";
const KATY = "23501 Cinco Ranch Blvd, Katy, TX 77494";
const SPRING = "20131 Holzwarth Rd, Spring, TX 77388";
const BAD = "zzz not a place";

let calls;
// minutes(origin, destination) -> number | "unreachable" | "not-found"
let minutes;
let failWith;

function stubRoutes() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init) => {
      const body = JSON.parse(init.body);
      calls.push({ url, headers: init.headers, body });
      if (failWith) return failWith(body);
      const origins = body.origins.map((o) => o.waypoint.address);
      const destinations = body.destinations.map((d) => d.waypoint.address);
      if ([...origins, ...destinations].includes(BAD)) {
        return { ok: false, status: 400, json: async () => ({ error: { code: 400, message: "Invalid address", status: "INVALID_ARGUMENT" } }) };
      }
      const elements = [];
      origins.forEach((origin, originIndex) => {
        destinations.forEach((destination, destinationIndex) => {
          const value = minutes(origin, destination);
          const element = { destinationIndex, status: {} };
          // Proto JSON leaves zero values out.
          if (originIndex) element.originIndex = originIndex;
          if (!destinationIndex) delete element.destinationIndex;
          if (value === "unreachable") Object.assign(element, { status: { code: 5, message: "Not found" } });
          else if (value === "not-found") Object.assign(element, { condition: "ROUTE_NOT_FOUND" });
          else Object.assign(element, { condition: "ROUTE_EXISTS", duration: `${value * 60}s`, staticDuration: `${value * 60 - 30}s` });
          elements.push(element);
        });
      });
      // Elements may arrive in any order.
      return { ok: true, status: 200, json: async () => elements.reverse() };
    })
  );
}

beforeEach(() => {
  calls = [];
  minutes = () => 30;
  failWith = null;
  process.env.GOOGLE_MAPS_API_KEY = "test-maps-key";
  stubRoutes();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("16. driveTime module", () => {
  it("floors departure times to 15-minute buckets and clamps to now + 2 minutes", async () => {
    expect(sentDepartureTime(at("12:07"), NOW).toISOString()).toBe(at("12:00").toISOString());
    expect(sentDepartureTime(at("12:15"), NOW).toISOString()).toBe(at("12:15").toISOString());
    expect(sentDepartureTime(at("05:00"), NOW).toISOString()).toBe(at("06:02").toISOString());
    expect(sentDepartureTime(at("06:07"), NOW).toISOString()).toBe(at("06:02").toISOString());

    await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:07") }], { now: NOW });
    await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("04:00") }], { now: NOW });
    expect(calls.map((c) => c.body.departureTime)).toEqual(["2026-11-06T18:00:00.000Z", "2026-11-06T12:02:00.000Z"]);
  });

  it("sends the documented request shape", async () => {
    await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW });
    const [call] = calls;
    expect(call.url).toBe("https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix");
    expect(call.headers["X-Goog-Api-Key"]).toBe("test-maps-key");
    expect(call.headers["X-Goog-FieldMask"]).toBe("originIndex,destinationIndex,duration,staticDuration,condition,status");
    expect(call.body).toEqual({
      origins: [{ waypoint: { address: KATY } }],
      destinations: [{ waypoint: { address: CUSTOMER } }],
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_AWARE_OPTIMAL",
      departureTime: "2026-11-06T18:00:00.000Z"
    });
  });

  it("deduplicates identical legs", async () => {
    const results = await getDriveMatrix(
      [
        { from: KATY, to: CUSTOMER, departAt: at("12:00") },
        { from: `  ${KATY.toLowerCase()}  `, to: CUSTOMER.replace(/ /g, "   "), departAt: at("12:10") },
        { from: KATY, to: CUSTOMER, departAt: at("12:14") }
      ],
      { now: NOW }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body.origins).toHaveLength(1);
    expect(results).toEqual([{ minutes: 30 }, { minutes: 30 }, { minutes: 30 }]);
  });

  it("never mixes departure times in one call", async () => {
    await getDriveMatrix(
      [
        { from: KATY, to: CUSTOMER, departAt: at("12:00") },
        { from: SPRING, to: CUSTOMER, departAt: at("13:00") },
        { from: HOME, to: CUSTOMER, departAt: at("12:05") }
      ],
      { now: NOW }
    );
    expect(calls).toHaveLength(2);
    const byTime = Object.fromEntries(calls.map((c) => [c.body.departureTime, c.body.origins.map((o) => o.waypoint.address)]));
    expect(byTime).toEqual({
      "2026-11-06T18:00:00.000Z": [KATY, HOME],
      "2026-11-06T19:00:00.000Z": [SPRING]
    });
  });

  it("makes at most two calls per departure group: into and out of the customer", async () => {
    minutes = (origin, destination) => ({ [`${KATY}>${CUSTOMER}`]: 41, [`${CUSTOMER}>${SPRING}`]: 17 })[`${origin}>${destination}`] ?? 30;
    const departAt = at("14:00");
    const results = await getDriveMatrix(
      [
        { from: KATY, to: CUSTOMER, departAt },
        { from: SPRING, to: CUSTOMER, departAt },
        { from: HOME, to: CUSTOMER, departAt },
        { from: CUSTOMER, to: KATY, departAt },
        { from: CUSTOMER, to: SPRING, departAt }
      ],
      { now: NOW }
    );
    expect(calls).toHaveLength(2);
    const into = calls.find((c) => c.body.destinations.length === 1 && c.body.destinations[0].waypoint.address === CUSTOMER);
    const out = calls.find((c) => c.body.origins.length === 1 && c.body.origins[0].waypoint.address === CUSTOMER);
    expect(into.body.origins.map((o) => o.waypoint.address)).toEqual([KATY, SPRING, HOME]);
    expect(out.body.destinations.map((d) => d.waypoint.address)).toEqual([KATY, SPRING]);
    // Exactly the elements needed: 3 + 2, no unused pairs.
    expect(into.body.origins.length * into.body.destinations.length + out.body.origins.length * out.body.destinations.length).toBe(5);
    expect(results).toEqual([{ minutes: 41 }, { minutes: 30 }, { minutes: 30 }, { minutes: 30 }, { minutes: 17 }]);
  });

  it("asks a round 0 check (home base to everything) in one call", async () => {
    await getDriveMatrix(
      [CUSTOMER, KATY, SPRING].map((to) => ({ from: HOME, to, departAt: NOW })),
      { now: NOW }
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].body.origins).toEqual([{ waypoint: { address: HOME } }]);
    expect(calls[0].body.destinations).toHaveLength(3);
  });

  it('turns "1234s" into 21 minutes, rounding up', async () => {
    expect(durationToMinutes("1234s")).toBe(21);
    expect(durationToMinutes("1200s")).toBe(20);
    expect(durationToMinutes("1201s")).toBe(21);
    expect(durationToMinutes("3.5s")).toBe(1);
    minutes = () => 1234 / 60;
    const [result] = await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW });
    expect(result).toEqual({ minutes: 21 });
  });

  it("falls back to staticDuration when duration is absent", async () => {
    failWith = () => ({ ok: true, status: 200, json: async () => [{ condition: "ROUTE_EXISTS", staticDuration: "600s", status: {} }] });
    const [result] = await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW });
    expect(result).toEqual({ minutes: 10 });
  });

  it("marks ROUTE_NOT_FOUND and non-zero element status as unreachable", async () => {
    minutes = (origin) => (origin === KATY ? "not-found" : origin === SPRING ? "unreachable" : 25);
    const results = await getDriveMatrix(
      [KATY, SPRING, HOME].map((from) => ({ from, to: CUSTOMER, departAt: at("12:00") })),
      { now: NOW }
    );
    expect(results).toEqual([{ unreachable: true }, { unreachable: true }, { minutes: 25 }]);
  });

  it("retries a request-level 400 leg by leg and marks only the bad leg", async () => {
    const results = await getDriveMatrix(
      [KATY, BAD, SPRING].map((from) => ({ from, to: CUSTOMER, departAt: at("12:00") })),
      { now: NOW }
    );
    // One failed call, then one per leg.
    expect(calls).toHaveLength(4);
    expect(calls.slice(1).map((c) => c.body.origins.length)).toEqual([1, 1, 1]);
    expect(results).toEqual([{ minutes: 30 }, { unreachable: true }, { minutes: 30 }]);
  });

  it("splits a hub with more than 49 spokes to respect the 50-waypoint limit", async () => {
    const legs = Array.from({ length: 60 }, (_, i) => ({ from: `${i + 1} Main St, Houston, TX`, to: CUSTOMER, departAt: at("12:00") }));
    const results = await getDriveMatrix(legs, { now: NOW });
    expect(calls.map((c) => c.body.origins.length)).toEqual([49, 11]);
    expect(calls.every((c) => c.body.origins.length + c.body.destinations.length <= 50)).toBe(true);
    expect(results.every((r) => r.minutes === 30)).toBe(true);
  });

  it("missing GOOGLE_MAPS_API_KEY is a 503 naming the variable", async () => {
    delete process.env.GOOGLE_MAPS_API_KEY;
    const error = await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW }).catch((e) => e);
    expect(error.status).toBe(503);
    expect(error.message).toContain("GOOGLE_MAPS_API_KEY");
    expect(calls).toHaveLength(0);
  });

  it("HTTP 403, 429, 5xx and network failures are 502s", async () => {
    for (const status of [403, 500, 503]) {
      failWith = () => ({ ok: false, status, json: async () => ({ error: { code: status, status: "PERMISSION_DENIED" } }) });
      const error = await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW }).catch((e) => e);
      expect(error.status).toBe(502);
      expect(error.message).toBe("Google Routes request failed.");
    }
    // 429: the project's daily drive-pair limit is used up; say so plainly.
    failWith = () => ({ ok: false, status: 429, json: async () => ({ error: { code: 429, status: "RESOURCE_EXHAUSTED" } }) });
    const limited = await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW }).catch((e) => e);
    expect(limited.status).toBe(502);
    expect(limited.message).toBe(
      "Google Routes request failed: today's drive-time limit is used up. It resets at 2:00 AM Houston time."
    );
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    const error = await getDriveMatrix([{ from: KATY, to: CUSTOMER, departAt: at("12:00") }], { now: NOW }).catch((e) => e);
    expect(error.status).toBe(502);
  });

  it("getDriveMinutes returns minutes or throws when unreachable", async () => {
    expect(await getDriveMinutes(KATY, CUSTOMER, at("12:00"), { now: NOW })).toBe(30);
    minutes = () => "not-found";
    await expect(getDriveMinutes(KATY, CUSTOMER, at("12:00"), { now: NOW })).rejects.toThrow(/No drivable route/);
  });
});
