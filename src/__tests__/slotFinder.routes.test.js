// /api/slot-finder end to end: real route, settings, calendar and Routes
// modules, with Google faked at the fetch level. now is frozen at 06:00
// America/Chicago on Friday 2026-11-06.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { clearCalendarTokenCache } from "../services/googleCalendar.js";
import { chicagoInstant, toChicagoRfc3339 } from "../slotFinder/time.js";

const FRIDAY = "2026-11-06";
const at = (date, time) => chicagoInstant(date, time);
const NOW = at(FRIDAY, "06:00");

const HOME = "11822 Bandlon Dr, Houston, TX 77072";
const PASADENA = "2524 Chamberlain St, Pasadena, TX 77506";
const KATY = "23501 Cinco Ranch Blvd, Katy, TX 77494";
const SPRING = "20131 Holzwarth Rd, Spring, TX 77388";
const NOWHERE = "999 Nowhere Rd, Atlantis, TX 00000";
const PLACES = { [HOME]: "home", [PASADENA]: "pasadena", [KATY]: "katy", [SPRING]: "spring", [NOWHERE]: "nowhere" };

// The test 1 body, pinned here and in the MCP server's find_slots test.
const TEST1_BODY = {
  date: "2026-11-06",
  dayLabel: "today",
  state: "ok",
  slots: [
    { start: "19:00", driveInMin: 55, driveOutMin: null, leaveHomeBy: null },
    { start: "21:00", driveInMin: 55, driveOutMin: null, leaveHomeBy: null }
  ],
  warnings: [],
  messageEn:
    "Hi, thanks for reaching out. For today I have availability at 7:00 PM and 9:00 PM. Which one works best for you? Once you pick, I will confirm the booking.",
  messageEs:
    "Hola, gracias por escribir. Para hoy tengo disponibilidad a las 7:00 PM y 9:00 PM. ¿Cuál le funciona mejor? Al elegir, le confirmo la cita.",
  durationMinutes: 60
};

let mongod;
let passwordHash;
let token;
let accountId;

function timed(start, end, { location = "", summary = "Job", ...rest } = {}) {
  return {
    summary,
    location,
    status: "confirmed",
    start: { dateTime: toChicagoRfc3339(at(FRIDAY, start)) },
    end: { dateTime: toChicagoRfc3339(at(FRIDAY, end)) },
    ...rest
  };
}

const TEST1_EVENTS = [
  timed("09:00", "10:00", { location: SPRING, summary: "PS5 HDMI" }),
  timed("11:00", "12:00", { location: KATY, summary: "Xbox cleaning" }),
  timed("15:00", "16:00", { location: KATY, summary: "PS4 thermal paste" })
];
const TEST1_DRIVES = { "katy>pasadena": 55, "pasadena>katy": 55 };

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Fakes the three Google endpoints. `pages` splits the events over several
// calendar pages to exercise nextPageToken.
function fakeGoogle({ items = [], pages = null, drives = {}, fallback = 30, unreachable = [], tokenError = null, calendarStatus = 200, routesStatus = 200 } = {}) {
  const log = { token: 0, calendar: [], routes: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      const href = String(url);
      if (href === "https://oauth2.googleapis.com/token") {
        log.token += 1;
        log.tokenBody = Object.fromEntries(new URLSearchParams(String(init.body)));
        if (tokenError) return reply(400, { error: tokenError, error_description: "Token has been expired or revoked." });
        return reply(200, { access_token: "access-token-1", expires_in: 3599, token_type: "Bearer" });
      }
      if (href.startsWith("https://www.googleapis.com/calendar/v3/calendars/")) {
        const parsed = new URL(href);
        log.calendar.push({ url: parsed, headers: init.headers });
        if (calendarStatus !== 200) return reply(calendarStatus, { error: { code: calendarStatus } });
        if (!pages) return reply(200, { items });
        const index = Number(parsed.searchParams.get("pageToken") || 0);
        return reply(200, { items: pages[index], ...(index + 1 < pages.length ? { nextPageToken: String(index + 1) } : {}) });
      }
      if (href === "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix") {
        const body = JSON.parse(init.body);
        log.routes.push(body);
        if (routesStatus !== 200) return reply(routesStatus, { error: { code: routesStatus, status: "PERMISSION_DENIED" } });
        const elements = [];
        body.origins.forEach((o, originIndex) => {
          body.destinations.forEach((d, destinationIndex) => {
            const key = `${PLACES[o.waypoint.address]}>${PLACES[d.waypoint.address]}`;
            const element = { originIndex, destinationIndex };
            if (unreachable.includes(key)) Object.assign(element, { status: { code: 5, message: "Not found" } });
            else Object.assign(element, { status: {}, condition: "ROUTE_EXISTS", duration: `${(drives[key] ?? fallback) * 60}s` });
            elements.push(element);
          });
        });
        return reply(200, elements);
      }
      throw new Error(`Unexpected fetch: ${href}`);
    })
  );
  return log;
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());
  passwordHash = await bcrypt.hash("password123", 10);
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await mongoose.connection.dropDatabase();
  const account = await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  accountId = String(account._id);
  const login = await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" });
  token = login.body.token;
  Object.assign(process.env, {
    GOOGLE_CALENDAR_CLIENT_ID: "client-id",
    GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token-secret",
    GOOGLE_CALENDAR_ACCOUNT_ID: accountId,
    GOOGLE_MAPS_API_KEY: "maps-key"
  });
  delete process.env.GOOGLE_CALENDAR_ID;
  clearCalendarTokenCache();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const authed = (req) => req.set("Authorization", `Bearer ${token}`);
const find = (query) => authed(request(app).get("/api/slot-finder")).query(query);
const findPost = (body) => authed(request(app).post("/api/slot-finder")).send(body);

describe("access", () => {
  it("needs a signed-in owner", async () => {
    expect((await request(app).get(`/api/slot-finder?address=x`)).status).toBe(401);
    expect((await request(app).post("/api/slot-finder").send({ address: "x" })).status).toBe(401);
    expect((await request(app).get("/api/slot-finder/settings")).status).toBe(401);
  });

  it("is off (503) until GOOGLE_CALENDAR_ACCOUNT_ID is set, and 403 for any other account", async () => {
    fakeGoogle();
    delete process.env.GOOGLE_CALENDAR_ACCOUNT_ID;
    const off = await find({ address: PASADENA });
    expect(off.status).toBe(503);
    expect(off.body.error).toContain("GOOGLE_CALENDAR_ACCOUNT_ID");

    process.env.GOOGLE_CALENDAR_ACCOUNT_ID = new mongoose.Types.ObjectId().toString();
    const other = await find({ address: PASADENA });
    expect(other.status).toBe(403);
  });
});

describe("acceptance through the API", () => {
  it("1. the worked example, by GET and by POST, gives the pinned body", async () => {
    const log = fakeGoogle({ items: TEST1_EVENTS, drives: TEST1_DRIVES });
    const viaGet = await find({ date: FRIDAY, address: PASADENA, duration: "60" });
    expect(viaGet.status).toBe(200);
    expect(viaGet.body).toEqual(TEST1_BODY);

    const viaPost = await findPost({ date: FRIDAY, address: PASADENA, duration: 60 });
    expect(viaPost.body).toEqual(TEST1_BODY);

    // The calendar was asked for the whole Chicago day, recurring events expanded.
    const { url, headers } = log.calendar[0];
    expect(url.pathname).toBe("/calendar/v3/calendars/primary/events");
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("timeMin")).toBe("2026-11-06T00:00:00-06:00");
    expect(url.searchParams.get("timeMax")).toBe("2026-11-07T00:00:00-06:00");
    expect(headers.Authorization).toBe("Bearer access-token-1");
    expect(log.tokenBody).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      refresh_token: "refresh-token-secret",
      grant_type: "refresh_token"
    });
    // The access token is cached across requests.
    expect(log.token).toBe(1);
    // Never sent anything to Google that a departure in the past would break.
    expect(log.routes.every((body) => new Date(body.departureTime) > NOW)).toBe(true);
  });

  it("reads every calendar page and the configured calendar id", async () => {
    process.env.GOOGLE_CALENDAR_ID = "owner@example.com";
    const log = fakeGoogle({ pages: [[TEST1_EVENTS[0]], [TEST1_EVENTS[1]], [TEST1_EVENTS[2]]], drives: TEST1_DRIVES });
    const res = await find({ date: FRIDAY, address: PASADENA });
    expect(res.body.slots.map((s) => s.start)).toEqual(["19:00", "21:00"]);
    expect(log.calendar).toHaveLength(3);
    expect(log.calendar[0].url.pathname).toBe("/calendar/v3/calendars/owner%40example.com/events");
  });

  it("5. bad address is a 400 with the exact text", async () => {
    fakeGoogle({ unreachable: ["home>pasadena"] });
    const res = await find({ date: FRIDAY, address: PASADENA });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Address not found or unreachable. Check the spelling and try again.");
  });

  it("9. a booking that cannot be routed: 200 with a warning", async () => {
    fakeGoogle({ items: [timed("11:00", "12:00", { location: NOWHERE, summary: "Fix PS5" })], unreachable: ["home>nowhere"] });
    const res = await find({ date: FRIDAY, address: PASADENA });
    expect(res.status).toBe(200);
    expect(res.body.slots.map((s) => s.start)).not.toContain("11:00");
    expect(res.body.slots.find((s) => s.start === "13:00").leaveHomeBy).toBe("12:20 PM");
    expect(res.body.warnings).toContain("Could not route to the 11:00 AM booking (Fix PS5), so it was treated as a time block only.");
  });

  it("10. past date: no Google calls", async () => {
    const log = fakeGoogle();
    const res = await find({ date: "2026-11-05", address: PASADENA });
    expect(res.body).toMatchObject({ state: "past_date", slots: [], warnings: [], messageEn: null, messageEs: null });
    expect(log.routes).toHaveLength(0);
    expect(log.calendar).toHaveLength(0);
  });

  it("14. validation", async () => {
    fakeGoogle();
    for (const duration of ["10", "300", "abc", "60.5", "-30"]) {
      const res = await find({ address: PASADENA, duration });
      expect(res.status, duration).toBe(400);
    }
    const badDate = await find({ address: PASADENA, date: "2026-13-40" });
    expect(badDate.status).toBe(400);
    expect((await find({ address: PASADENA, date: "2026-02-30" })).status).toBe(400);
    expect((await find({ address: PASADENA, date: "11/06/2026" })).status).toBe(400);

    for (const address of ["", "   "]) {
      const res = await find({ address });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe("Address is required.");
    }
    expect((await find({})).body.error).toBe("Address is required.");
    expect((await findPost({ address: "   " })).body.error).toBe("Address is required.");
  });

  it("15. config and upstream errors", async () => {
    fakeGoogle();
    delete process.env.GOOGLE_MAPS_API_KEY;
    const noKey = await find({ date: FRIDAY, address: PASADENA });
    expect(noKey.status).toBe(503);
    expect(noKey.body.error).toContain("GOOGLE_MAPS_API_KEY");
    process.env.GOOGLE_MAPS_API_KEY = "maps-key";

    fakeGoogle({ routesStatus: 403 });
    const forbidden = await find({ date: FRIDAY, address: PASADENA });
    expect(forbidden.status).toBe(502);
    expect(forbidden.body.error).toBe("Google Routes request failed.");

    clearCalendarTokenCache();
    fakeGoogle({ tokenError: "invalid_grant" });
    const revoked = await find({ date: FRIDAY, address: PASADENA });
    expect(revoked.status).toBe(502);
    expect(revoked.body.error.startsWith("Google Calendar request failed.")).toBe(true);
    // The refresh token never comes back in a response.
    expect(JSON.stringify(revoked.body)).not.toContain("refresh-token-secret");

    fakeGoogle({ calendarStatus: 500 });
    const calendarDown = await find({ date: FRIDAY, address: PASADENA });
    expect(calendarDown.status).toBe(502);
    expect(calendarDown.body.error).toBe("Google Calendar request failed.");

    delete process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
    clearCalendarTokenCache();
    const noRefresh = await find({ date: FRIDAY, address: PASADENA });
    expect(noRefresh.status).toBe(503);
    expect(noRefresh.body.error).toContain("GOOGLE_CALENDAR_REFRESH_TOKEN");
  });

  it("18 (API side). service sets the duration: Controller repair is 45 minutes", async () => {
    // Katy 12:00-13:00, 5-minute drives: an 11:00 job fits only if it is 45 minutes
    // (11:45 + 5 + 10 = 12:00), not 60 (12:00 + 5 + 10 = 12:15).
    const events = [timed("12:00", "13:00", { location: KATY })];
    fakeGoogle({ items: events, fallback: 5 });
    const short = await findPost({ date: FRIDAY, address: PASADENA, service: "Controller repair" });
    expect(short.body.durationMinutes).toBe(45);
    expect(short.body.slots.map((s) => s.start)).toContain("11:00");

    const long = await findPost({ date: FRIDAY, address: PASADENA, service: "HDMI repair" });
    expect(long.body.durationMinutes).toBe(60);
    expect(long.body.slots.map((s) => s.start)).not.toContain("11:00");

    // An explicit duration wins over the service; neither means 60.
    expect((await findPost({ date: FRIDAY, address: PASADENA, service: "Controller repair", duration: 90 })).body.durationMinutes).toBe(90);
    expect((await findPost({ date: FRIDAY, address: PASADENA })).body.durationMinutes).toBe(60);

    const unknown = await findPost({ date: FRIDAY, address: PASADENA, service: "Laptop" });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error).toMatch(/^Unknown service/);
  });

  it("defaults the date to today in Chicago", async () => {
    fakeGoogle();
    const res = await find({ address: PASADENA });
    expect(res.body.date).toBe(FRIDAY);
    expect(res.body.dayLabel).toBe("today");
  });
});

describe("privacy", () => {
  it("does not save or log the pasted address", async () => {
    fakeGoogle({ items: TEST1_EVENTS, drives: TEST1_DRIVES });
    const written = [];
    vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      written.push(String(chunk));
      return true;
    });
    vi.spyOn(console, "log").mockImplementation((...args) => written.push(args.join(" ")));
    vi.spyOn(console, "error").mockImplementation((...args) => written.push(args.join(" ")));

    await find({ date: FRIDAY, address: PASADENA });
    await findPost({ date: FRIDAY, address: PASADENA });
    await new Promise((resolve) => setTimeout(resolve, 50));
    vi.restoreAllMocks();

    expect(written.some((line) => line.includes("/api/slot-finder"))).toBe(true);
    expect(written.join("\n")).not.toContain("Chamberlain");

    const collections = await mongoose.connection.db.listCollections().toArray();
    for (const { name } of collections) {
      const docs = await mongoose.connection.db.collection(name).find({}).toArray();
      expect(JSON.stringify(docs), name).not.toContain("Chamberlain");
    }
  });
});

describe("settings", () => {
  it("seeds the defaults on first use and stores them on the account", async () => {
    const res = await authed(request(app).get("/api/slot-finder/settings"));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      slotStarts: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"],
      serviceDurations: { "HDMI repair": 60, Cleaning: 60, "Thermal paste": 60, "Controller repair": 45, Other: 60 },
      bufferMinutes: 10,
      homeBase: HOME
    });
    expect(Object.keys(res.body.messageTemplates)).toEqual(["enMany", "enOne", "esMany", "esOne"]);
    const stored = await Settings.findById(accountId).lean();
    expect(stored.slotFinder.bufferMinutes).toBe(10);
  });

  it("updates part of the settings, refuses bad values, and searches use them", async () => {
    const put = await authed(request(app).put("/api/slot-finder/settings")).send({
      slotStarts: ["16:00", "10:00"],
      bufferMinutes: 0,
      messageTemplates: { enOne: "Free {dayLabel} at {slot}." }
    });
    expect(put.status).toBe(200);
    expect(put.body.slotStarts).toEqual(["10:00", "16:00"]);
    expect(put.body.homeBase).toBe(HOME);

    for (const body of [
      { slotStarts: ["9am"] },
      { serviceDurations: { Cleaning: 5 } },
      { serviceDurations: { "a.b": 60 } },
      { bufferMinutes: -1 },
      { homeBase: "  " },
      { messageTemplates: { esOne: "" } }
    ]) {
      const res = await authed(request(app).put("/api/slot-finder/settings")).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }

    fakeGoogle({ items: [timed("08:00", "15:00", { location: KATY })] });
    const res = await find({ date: FRIDAY, address: PASADENA });
    expect(res.body.slots).toEqual([{ start: "16:00", driveInMin: 30, driveOutMin: null, leaveHomeBy: null }]);
    expect(res.body.messageEn).toBe("Free today at 4:00 PM.");
  });
});
