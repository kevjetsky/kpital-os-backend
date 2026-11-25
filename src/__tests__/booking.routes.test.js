// Online booking (/api/public/booking and /api/bookings) end to end: real
// routes, Slot Finder, Mongo and Routes/Calendar modules, with every outside
// service faked at the fetch level. now is frozen at 12:00 noon
// America/Chicago on Tuesday 2026-12-01.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Booking, BookingLock } from "../booking/models.js";
import { clearBookingDriveCache } from "../booking/drive.js";
import { clearCalendarTokenCache } from "../services/googleCalendar.js";
import { clearGeoCache } from "../services/geoService.js";
import { chicagoInstant, toChicagoRfc3339 } from "../slotFinder/time.js";

const TODAY = "2026-12-01";
const NOW = chicagoInstant(TODAY, "12:00");
const ORIGIN = "https://booking-beta.we-fix-consoles.pages.dev";

const HOME = "11822 Bandlon Dr, Houston, TX 77072";
const MAIN = "100 Main St, Houston, TX 77002";
const ELM = "200 Elm St, Houston, TX 77007";
// Census answers by what was typed (lowercase); Routes by the formatted address.
const PLACES = {
  "11822 bandlon dr, houston, tx 77072": { lat: 29.7, lng: -95.58, state: "TX", city: "HOUSTON", zip: "77072", street: "11822 BANDLON DR" },
  "100 main st, houston, tx 77002": { lat: 29.76, lng: -95.36, state: "TX", city: "HOUSTON", zip: "77002", street: "100 MAIN ST" },
  "200 elm st, houston, tx 77007": { lat: 29.77, lng: -95.4, state: "TX", city: "HOUSTON", zip: "77007", street: "200 ELM ST" },
  "1 canal st, new orleans, la 70130": { lat: 29.95, lng: -90.07, state: "LA", city: "NEW ORLEANS", zip: "70130", street: "1 CANAL ST" },
  "500 commerce st, dallas, tx 75202": { lat: 32.78, lng: -96.8, state: "TX", city: "DALLAS", zip: "75202", street: "500 COMMERCE ST" }
};
const point = (address) => PLACES[String(address).toLowerCase()];

// Drive minutes from straight-line distance, like a real road network.
function minutesBetween(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  const miles = (2 * 6371 * Math.asin(Math.sqrt(h))) / 1.609344;
  return Math.round(miles < 0.05 ? 0 : 6 + (miles * 1.3 * 60) / 38);
}

let mongod;
let passwordHash;
let token;
let accountId;
let google;

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

// Fakes Google (token, Calendar list/insert/delete, Routes), the Census and
// Photon address lookups, Turnstile and Resend.
function fakeServices({ events = [], routesStatus = 200 } = {}) {
  const log = { routesCalls: 0, elements: 0, inserted: [], deleted: [], emails: [], calendarReads: 0 };
  let nextEvent = 1;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      const href = String(url);
      const parsed = new URL(href);
      if (href === "https://oauth2.googleapis.com/token") return reply(200, { access_token: "access-1", expires_in: 3599 });
      if (parsed.hostname === "www.googleapis.com") {
        const method = init.method || "GET";
        if (method === "POST") {
          const event = JSON.parse(init.body);
          const id = `evt${nextEvent++}`;
          log.inserted.push({ id, ...event });
          return reply(200, { id, htmlLink: `https://calendar.google.com/event?eid=${id}` });
        }
        if (method === "DELETE") {
          log.deleted.push(parsed.pathname.split("/").pop());
          return reply(204, null);
        }
        log.calendarReads += 1;
        const timeMin = new Date(parsed.searchParams.get("timeMin"));
        const timeMax = new Date(parsed.searchParams.get("timeMax"));
        const items = [...events, ...log.inserted.filter((e) => !log.deleted.includes(e.id))].filter((item) => {
          const start = new Date(item.start.dateTime);
          return start >= timeMin && start < timeMax;
        });
        return reply(200, { items });
      }
      if (href === "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix") {
        log.routesCalls += 1;
        if (routesStatus !== 200) return reply(routesStatus, { error: { code: routesStatus } });
        const body = JSON.parse(init.body);
        const elements = [];
        body.origins.forEach((o, originIndex) => {
          body.destinations.forEach((d, destinationIndex) => {
            log.elements += 1;
            const [from, to] = [point(o.waypoint.address), point(d.waypoint.address)];
            if (!from || !to) elements.push({ originIndex, destinationIndex, condition: "ROUTE_NOT_FOUND" });
            else elements.push({ originIndex, destinationIndex, condition: "ROUTE_EXISTS", duration: `${minutesBetween(from, to) * 60}s` });
          });
        });
        return reply(200, elements);
      }
      if (parsed.hostname === "geocoding.geo.census.gov") {
        const place = point(parsed.searchParams.get("address"));
        const matches = place
          ? [{ matchedAddress: `${place.street}, ${place.city}, ${place.state}, ${place.zip}`, coordinates: { x: place.lng, y: place.lat }, addressComponents: { city: place.city, state: place.state, zip: place.zip } }]
          : [];
        return reply(200, { result: { addressMatches: matches } });
      }
      if (parsed.hostname === "photon.komoot.io") {
        const q = parsed.searchParams.get("q").toLowerCase();
        const features = q.startsWith("main")
          ? [
              { properties: { countrycode: "US", type: "street", name: "Main Street", city: "Houston", state: "Texas" }, geometry: { coordinates: [-95.36, 29.76] } },
              { properties: { countrycode: "US", type: "street", name: "Main Street", city: "Bellaire", state: "Texas" }, geometry: { coordinates: [-95.46, 29.7] } }
            ]
          : [];
        return reply(200, { features });
      }
      if (href === "https://challenges.cloudflare.com/turnstile/v0/siteverify") {
        return reply(200, { success: new URLSearchParams(String(init.body)).get("response") === "good-token" });
      }
      if (href === "https://api.resend.com/emails") {
        log.emails.push(JSON.parse(init.body));
        return reply(200, { id: "email-1" });
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

const BOOKING_ENV = {
  BOOKING_ENABLED: "true",
  BOOKING_AREA_TOKEN_SECRET: "test-area-secret",
  BOOKING_ALLOWED_ORIGINS: "https://we-fix-consoles.com",
  BOOKING_ALLOWED_ORIGIN_SUFFIXES: ".we-fix-consoles.pages.dev",
  GEO_LOOKUP: "on"
};

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now: NOW });
  await mongoose.connection.dropDatabase();
  await Promise.all([Booking.syncIndexes(), BookingLock.syncIndexes()]);
  const account = await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  accountId = String(account._id);
  const login = await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" });
  token = login.body.token;
  Object.assign(process.env, BOOKING_ENV, {
    GOOGLE_CALENDAR_CLIENT_ID: "client-id",
    GOOGLE_CALENDAR_CLIENT_SECRET: "client-secret",
    GOOGLE_CALENDAR_REFRESH_TOKEN: "refresh-token-secret",
    GOOGLE_CALENDAR_ACCOUNT_ID: accountId,
    GOOGLE_MAPS_API_KEY: "maps-key",
    RESEND_API_KEY: "re_test"
  });
  for (const name of ["GOOGLE_CALENDAR_ID", "BOOKING_TURNSTILE_SECRET", "BOOKING_MAPS_DAILY_CAP", "BOOKING_EMAIL_FROM"]) delete process.env[name];
  clearCalendarTokenCache();
  clearGeoCache();
  clearBookingDriveCache();
  google = fakeServices();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env.GEO_LOOKUP = "off";
});

let ipCounter = 0;
const call = (method, path, { body, headers = {}, ip, origin = ORIGIN } = {}) => {
  let req = request(app)[method](`/api/public/booking${path}`).set("X-Forwarded-For", ip || "203.0.113.7");
  if (origin) req = req.set("Origin", origin);
  for (const [name, value] of Object.entries(headers)) req = req.set(name, value);
  return body === undefined ? req : req.send(body);
};
const freshIp = () => `198.51.100.${++ipCounter % 250}`;
const authed = (req) => req.set("Authorization", `Bearer ${token}`);

const DETAILS = { name: "Carlos Test", phone: "(346) 555-0123", service: "hdmi", console: "ps5", smsConsent: false, utm: { source: "google", medium: "cpc" } };

async function checkArea(address = MAIN) {
  const res = await call("post", "/check-area", { body: { address }, ip: freshIp() });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  expect(res.body.inside, JSON.stringify(res.body)).toBe(true);
  return res.body;
}

async function holdFirstSlot(address = MAIN, { skipToday = true } = {}) {
  const area = await checkArea(address);
  const days = await call("get", `/days?areaToken=${encodeURIComponent(area.areaToken)}`, { ip: freshIp() });
  const day = days.body.find((d) => !skipToday || d.date !== TODAY) || days.body[0];
  const slots = await call("get", `/slots?areaToken=${encodeURIComponent(area.areaToken)}&date=${day.date}`, { ip: freshIp() });
  expect(slots.body.length).toBeGreaterThan(0);
  const hold = await call("post", "/hold", { body: { areaToken: area.areaToken, start: slots.body[0].start }, ip: freshIp() });
  expect(hold.status, JSON.stringify(hold.body)).toBe(200);
  return { areaToken: area.areaToken, day, slots: slots.body, hold: hold.body };
}

const book = (holdId, key, extra = {}, ip = freshIp()) =>
  call("post", "/book", { body: { ...DETAILS, holdId, ...extra }, headers: { "Idempotency-Key": key }, ip });

describe("the booking flow", () => {
  it("check-area, days, slots, hold, book: one calendar event, and the same Idempotency-Key twice books once", async () => {
    const area = await checkArea(MAIN);
    expect(area.address).toBe(MAIN);
    const days = await call("get", `/days?areaToken=${encodeURIComponent(area.areaToken)}`);
    expect(days.status).toBe(200);
    expect(days.body).toHaveLength(7);
    // ~34 minutes from home: the 21:00 slot (home by 22:20) never fits. Noon
    // today with a 90-minute lead leaves 15:00, 17:00 and 19:00.
    expect(days.body[0]).toEqual({ date: TODAY, free: 3 });
    expect(days.body[1]).toEqual({ date: "2026-12-02", free: 6 });

    const { hold, slots } = await holdFirstSlot(ELM);
    expect(slots[0].start).toMatch(/^2026-12-0\dT\d\d:00:00-06:00$/);
    const first = await book(hold.holdId, "key-aaaaaaaa");
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body.bookingId).toMatch(/^WFC-[A-Z2-9]{6}$/);
    expect(first.body).toMatchObject({ start: hold.start, address: ELM, service: "HDMI port repair", console: "PS5" });
    const replay = await book(hold.holdId, "key-aaaaaaaa");
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(replay.headers["idempotent-replay"]).toBe("true");

    expect(google.inserted).toHaveLength(1);
    expect(google.inserted[0]).toMatchObject({ summary: "HDMI port repair - Carlos Test", location: ELM, colorId: "9" });
    expect(google.inserted[0].start.dateTime).toBe(hold.start);
    expect(google.inserted[0].description).toContain(`Booking ID: ${first.body.bookingId}`);
    expect(google.inserted[0].description).toContain('<a href="tel:+13465550123">');

    const [saved] = await Booking.find({ accountId }).lean();
    expect(saved).toMatchObject({ phone: "+13465550123", leadSource: "google / cpc", eventId: "evt1", status: "booked" });
    // The booked time no longer shows.
    const after = await call("get", `/slots?areaToken=${encodeURIComponent((await checkArea(ELM)).areaToken)}&date=${first.body.start.slice(0, 10)}`);
    expect(after.body.some((s) => s.start === first.body.start)).toBe(false);
  });

  it("tells the owner: a push attempt and an email to the owner's address; no customer email without BOOKING_EMAIL_FROM", async () => {
    const { hold } = await holdFirstSlot();
    const res = await book(hold.holdId, "notify-key-1", { email: "carlos@example.com" });
    expect(res.status).toBe(200);
    expect(google.emails).toHaveLength(1);
    expect(google.emails[0].to).toEqual(["owner@example.com"]);
    expect(google.emails[0].subject).toMatch(/^New booking: Wed Dec 2, 9:00 AM - HDMI port repair$/);

    process.env.BOOKING_EMAIL_FROM = "We-Fix-Consoles <bookings@we-fix-consoles.com>";
    const second = await holdFirstSlot(ELM);
    expect((await book(second.hold.holdId, "notify-key-2", { email: "ana@example.com", phone: "3465550111" })).status).toBe(200);
    const customer = google.emails.find((mail) => mail.to[0] === "ana@example.com");
    expect(customer.from).toBe("We-Fix-Consoles <bookings@we-fix-consoles.com>");
    expect(customer.attachments[0].filename).toBe("we-fix-consoles.ics");
  });

  it("two parallel /book calls on one hold: one 200, one 409, one calendar event", async () => {
    const { hold } = await holdFirstSlot();
    const [a, b] = await Promise.all([book(hold.holdId, "parallel-1"), book(hold.holdId, "parallel-2", { phone: "3465550199" })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await Booking.countDocuments({ accountId })).toBe(1);
    expect(google.inserted).toHaveLength(1);
  });

  it("a second customer cannot hold a time that is held; the holder still sees it", async () => {
    const { hold, areaToken, day } = await holdFirstSlot();
    const again = await call("post", "/hold", { body: { areaToken, start: hold.start }, ip: freshIp() });
    expect(again.status).toBe(409);
    expect(again.body.error).toBe("slot_taken");
    expect(again.body.slots.some((s) => s.start === hold.start)).toBe(false);
    const own = await call("get", `/slots?areaToken=${encodeURIComponent(areaToken)}&date=${day.date}&holdId=${hold.holdId}`);
    expect(own.body.some((s) => s.start === hold.start)).toBe(true);
  });

  it("an expired hold cannot be booked", async () => {
    const { hold } = await holdFirstSlot();
    vi.setSystemTime(new Date(NOW.getTime() + 11 * 60000));
    const res = await book(hold.holdId, "late-key-1");
    expect(res.status).toBe(409);
    expect(res.body.error).toBe("hold_expired");
    expect(google.inserted).toHaveLength(0);
  });

  it("caps: two upcoming bookings per phone, one per address per day", async () => {
    const first = await holdFirstSlot(MAIN);
    expect((await book(first.hold.holdId, "cap-key-1")).status).toBe(200);
    const sameDay = first.slots.find((s) => s.start !== first.hold.start);
    const hold2 = await call("post", "/hold", { body: { areaToken: first.areaToken, start: sameDay.start }, ip: freshIp() });
    expect((await book(hold2.body.holdId, "cap-key-2", { phone: "3465550111" })).body.error).toBe("address_cap");
    const other = await holdFirstSlot(ELM);
    expect((await book(other.hold.holdId, "cap-key-3")).status).toBe(200);
    const days = await call("get", `/days?areaToken=${encodeURIComponent(other.areaToken)}`, { ip: freshIp() });
    const slot = (await call("get", `/slots?areaToken=${encodeURIComponent(other.areaToken)}&date=${days.body[3].date}`, { ip: freshIp() })).body[0];
    const hold3 = await call("post", "/hold", { body: { areaToken: other.areaToken, start: slot.start }, ip: freshIp() });
    expect((await book(hold3.body.holdId, "cap-key-4")).body.error).toBe("phone_cap");
  });

  it("input checks: US phone, each service takes its own devices, Other needs a description, HTML is stripped", async () => {
    const { hold } = await holdFirstSlot();
    const send = (extra, key) => book(hold.holdId, key, extra);
    expect((await send({ phone: "12345" }, "bad-phone-1")).body.error).toBe("invalid_phone");
    expect((await send({ service: "cleaning" }, "old-service-1")).body.error).toBe("invalid_service");
    expect((await send({ service: "stick_drift", console: "ps5" }, "drift-ps5-1")).body.error).toBe("invalid_console");
    expect((await send({ service: "hdmi_liquid_metal", console: "xbox_series_x" }, "lm-xbox-1")).body.error).toBe("invalid_console");
    expect((await send({ service: "other", console: "ps4" }, "other-empty-1")).body.error).toBe("issue_required");
    const ok = await send({ service: "other", console: "ps4", issue: "<i>Disc</i> won't eject", name: "<b>Ana</b> Lopez", notes: "<script>x</script>Gate 1234" }, "html-strip-1");
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    const [saved] = await Booking.find({ accountId }).lean();
    expect(saved).toMatchObject({ name: "Ana Lopez", notes: "xGate 1234", serviceLabel: "Other", issue: "Disc won't eject", device: "PS4" });
    expect(google.inserted[0].description).toContain("What's wrong: Disc won't eject");
  });
});

describe("availability is the Slot Finder's", () => {
  it("calendar events and Kpital OS jobs block their time; a day where nothing fits is left out", async () => {
    const day = "2026-12-03";
    const busy = (start, end, location = "") => ({
      summary: "Job",
      location,
      status: "confirmed",
      start: { dateTime: toChicagoRfc3339(chicagoInstant(day, start)) },
      end: { dateTime: toChicagoRfc3339(chicagoInstant(day, end)) }
    });
    vi.unstubAllGlobals();
    google = fakeServices({ events: [busy("08:30", "12:30", MAIN), busy("13:00", "18:30", MAIN)] });
    // A job booked in Kpital OS at 19:00.
    const job = await authed(request(app).post("/api/entries")).send({
      type: "Repair",
      date: day,
      description: "HDMI port",
      income: 100,
      customerPhone: "555-0101",
      scheduledTime: "19:00",
      jobStatus: "Booked"
    });
    expect(job.status).toBe(201);

    const area = await checkArea(MAIN);
    const days = (await call("get", `/days?areaToken=${encodeURIComponent(area.areaToken)}`)).body;
    // 09-19 all taken, and 21:00 is too far from home for this address.
    expect(days.some((d) => d.date === day)).toBe(false);
    expect(days.some((d) => d.date === "2026-12-04")).toBe(true);

    // Someone living near home base still gets 21:00 that day.
    const near = await checkArea(HOME);
    const nearDays = (await call("get", `/days?areaToken=${encodeURIComponent(near.areaToken)}`)).body;
    expect(nearDays.find((d) => d.date === day)).toEqual({ date: day, free: 1 });
  });

  it("a week of days costs a few dozen Routes elements, a second look costs none, and the daily cap answers maps_budget", async () => {
    const area = await checkArea(MAIN);
    const before = google.elements;
    expect((await call("get", `/days?areaToken=${encodeURIComponent(area.areaToken)}`)).status).toBe(200);
    const week = google.elements - before;
    expect(week).toBeGreaterThan(0);
    expect(week).toBeLessThanOrEqual(30);
    const again = google.elements;
    await call("get", `/days?areaToken=${encodeURIComponent(area.areaToken)}`);
    expect(google.elements).toBe(again);

    clearBookingDriveCache();
    process.env.BOOKING_MAPS_DAILY_CAP = "5";
    const capped = await call("get", `/days?areaToken=${encodeURIComponent(area.areaToken)}`);
    expect(capped.status).toBe(503);
    expect(capped.body.error).toBe("maps_budget");
  });
});

describe("the service area", () => {
  it("outside Texas, unparseable, or over the drive cap: outside, and no token", async () => {
    for (const address of ["1 Canal St, New Orleans, LA 70130", "asdfgh", "500 Commerce St, Dallas, TX 75202"]) {
      const res = await call("post", "/check-area", { body: { address }, ip: freshIp() });
      expect(res.body, address).toEqual({ inside: false, reason: "outside_area" });
    }
  });

  it("a forged or missing areaToken is refused", async () => {
    expect((await call("get", "/days?areaToken=nope")).status).toBe(401);
    expect((await call("post", "/hold", { body: { start: "2026-12-02T15:00:00-06:00" } })).status).toBe(401);
  });
});

describe("address suggestions", () => {
  it("the exact Census match first, then Photon streets with the house number, without repeating the exact one", async () => {
    const exact = await call("post", "/suggest", { body: { q: MAIN } });
    expect(exact.status).toBe(200);
    expect(exact.body.exact).toMatchObject({ address: MAIN, zip: "77002" });
    expect(exact.body.streets.map((s) => s.label)).toEqual(["100 Main Street, Bellaire, TX"]);
    const typing = await call("post", "/suggest", { body: { q: "100 Main" } });
    expect(typing.body.exact).toBe(null);
    expect(typing.body.streets[0]).toMatchObject({ label: "100 Main Street, Houston, TX", hasNumber: true });
    expect((await call("post", "/suggest", { body: { q: "ab" } })).body).toEqual({ exact: null, streets: [] });
  });
});

describe("guards", () => {
  it("rate limit: the 11th /check-area from one address in an hour gets 429", async () => {
    for (let i = 0; i < 10; i++) expect((await call("post", "/check-area", { body: { address: MAIN }, ip: "192.0.2.1" })).status).toBe(200);
    const blocked = await call("post", "/check-area", { body: { address: MAIN }, ip: "192.0.2.1" });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);
    expect((await call("post", "/check-area", { body: { address: MAIN }, ip: "192.0.2.2" })).status).toBe(200);
  });

  it("Turnstile is checked when its secret is set", async () => {
    process.env.BOOKING_TURNSTILE_SECRET = "test-secret";
    expect((await call("post", "/check-area", { body: { address: MAIN, turnstileToken: "bad" } })).status).toBe(403);
    expect((await call("post", "/check-area", { body: { address: MAIN, turnstileToken: "good-token" } })).status).toBe(200);
  });

  it("CORS: website origins only, no cookies, and the preflight answers", async () => {
    expect((await call("get", "/status", { origin: "https://evil.example" })).status).toBe(403);
    const ok = await call("get", "/status", { origin: "https://we-fix-consoles.com" });
    expect(ok.headers["access-control-allow-origin"]).toBe("https://we-fix-consoles.com");
    expect(ok.headers["access-control-allow-credentials"]).toBeUndefined();
    expect((await call("get", "/status", { origin: "http://abc.we-fix-consoles.pages.dev" })).status).toBe(403);
    const preflight = await call("options", "/book", { headers: { "Access-Control-Request-Method": "POST" } });
    expect(preflight.status).toBe(204);
    expect(preflight.headers["access-control-allow-headers"]).toContain("Idempotency-Key");
    // The rest of the API still refuses the website.
    expect((await request(app).post("/api/auth/login").set("Origin", ORIGIN).send({})).status).toBe(403);
  });

  it("kill switch: BOOKING_ENABLED=false answers 503 and /status says so", async () => {
    process.env.BOOKING_ENABLED = "false";
    const res = await call("post", "/check-area", { body: { address: MAIN } });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("booking_disabled");
    const status = await call("get", "/status");
    expect(status.body).toMatchObject({ enabled: false, modes: { calendar: "google", drive: "google", geocode: "census" } });
  });
});

describe("the owner's bookings", () => {
  it("lists bookings and cancels one: the calendar event is removed and the time opens again", async () => {
    const { hold, areaToken, day } = await holdFirstSlot();
    const booked = await book(hold.holdId, "owner-key-1");
    expect(booked.status).toBe(200);
    expect((await request(app).get("/api/bookings")).status).toBe(401);
    const list = await authed(request(app).get("/api/bookings"));
    expect(list.status).toBe(200);
    expect(list.body.map((b) => b.bookingId)).toEqual([booked.body.bookingId]);

    const cancel = await authed(request(app).post(`/api/bookings/${booked.body.bookingId}/cancel`));
    expect(cancel.body).toEqual({ ok: true, calendarEvent: "deleted" });
    expect(google.deleted).toEqual(["evt1"]);
    expect((await Booking.findOne({ accountId }).lean()).status).toBe("cancelled");
    const slots = await call("get", `/slots?areaToken=${encodeURIComponent(areaToken)}&date=${day.date}`);
    expect(slots.body.some((s) => s.start === hold.start)).toBe(true);
  });

  it("is only for the business whose calendar takes the bookings", async () => {
    process.env.GOOGLE_CALENDAR_ACCOUNT_ID = new mongoose.Types.ObjectId().toString();
    expect((await authed(request(app).get("/api/bookings"))).status).toBe(403);
  });
});
