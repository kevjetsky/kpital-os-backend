// A day's route: the order of the stops, the drives between them, and whether
// each can be reached in time.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";
import { calendarStops, planDay, routePlan, streetKey } from "../insights/routePlan.js";
import { listDayEvents } from "../services/googleCalendar.js";

// The calendar is stubbed; the rest of the module (normalizeEvents) is real.
vi.mock("../services/googleCalendar.js", async (importOriginal) => ({ ...(await importOriginal()), listDayEvents: vi.fn() }));

// A Google Calendar event on DAY, Chicago time (CST, -06:00, in November).
const event = (summary, start, end, location = "", extra = {}) => ({
  status: "confirmed",
  summary,
  location,
  start: { dateTime: `${DAY}T${start}:00-06:00` },
  end: { dateTime: `${DAY}T${end}:00-06:00` },
  ...extra
});

const DAY = "2026-11-20";
let mongod;
let token;
let account;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Entry.syncIndexes();
  account = await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash: await bcrypt.hash("password123", 10) });
  token = (await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" })).body.token;
});
afterEach(() => {
  delete process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GOOGLE_CALENDAR_ACCOUNT_ID;
});

const authed = (req) => req.set("Authorization", `Bearer ${token}`);
const job = (fields) =>
  authed(request(app).post("/api/entries")).send({ type: "Repair", date: DAY, description: "Job", income: 100, customerPhone: "555-0101", jobStatus: "Booked", ...fields });

describe("planning the day", () => {
  const stops = [
    { _id: "a", order: 1, address: "A St", scheduledTime: "10:00", minutes: 60 },
    { _id: "b", order: 2, address: "B St", scheduledTime: "11:30", minutes: 60 },
    { _id: "c", order: 3, address: "C St", scheduledTime: "", minutes: 45 }
  ];

  it("works out when to leave, when each stop is reached, and when you are home", () => {
    const plan = planDay({
      date: DAY,
      stops,
      homeBase: "Home",
      bufferMinutes: 10,
      homeBy: "",
      drives: [{ minutes: 30 }, { minutes: 20 }, { minutes: 15 }, { minutes: 40 }]
    });
    expect(plan.leaveHomeBy).toBe("9:20 AM");
    expect(plan.stops.map((s) => [s.order, s.driveInMin, s.arriveAt, s.startAt, s.endAt, s.lateByMin])).toEqual([
      [1, 30, null, "10:00 AM", "11:00 AM", 0],
      [2, 20, "11:20 AM", "11:30 AM", "12:30 PM", 0],
      // No time of its own: it starts on arrival.
      [3, 15, "12:45 PM", "12:45 PM", "1:30 PM", 0]
    ]);
    expect(plan).toMatchObject({ driveHomeMin: 40, homeAt: "2:10 PM", totalDriveMin: 105, warnings: [] });
  });

  it("flags a stop you cannot reach in time, and a late night past the home-by time", () => {
    const plan = planDay({
      date: DAY,
      stops: stops.slice(0, 2),
      homeBase: "Home",
      bufferMinutes: 10,
      homeBy: "13:00",
      drives: [{ minutes: 30 }, { minutes: 35 }, { minutes: 40 }]
    });
    expect(plan.stops[1]).toMatchObject({ arriveAt: "11:35 AM", lateByMin: 15 });
    expect(plan.warnings).toEqual([
      "Stop 2 at 11:30 AM: you would get there about 15 min late.",
      "You would be home around 1:10 PM, after your 1:00 PM limit."
    ]);
  });

  it("keeps going when a drive cannot be worked out", () => {
    const plan = planDay({ date: DAY, stops: stops.slice(0, 1), homeBase: "Home", drives: [{ unreachable: true }, { minutes: 10 }] });
    expect(plan.stops[0]).toMatchObject({ driveInMin: null, startAt: "10:00 AM" });
    expect(plan.leaveHomeBy).toBeNull();
    expect(plan.warnings[0]).toContain("Could not work out the drive to stop 1");
  });
});

describe("the day's stops come from the calendar", () => {
  it("matches the street line, whatever the punctuation and city", () => {
    expect(streetKey("123 Main St., Houston, TX 77002, USA")).toBe("123 main st");
    expect(streetKey("  123  MAIN st")).toBe("123 main st");
  });

  it("takes timed events with a location in order, marks the ones already logged, and finds the customer", async () => {
    // Logged today at stop 1; an older job at stop 2 knows who lives there.
    await job({ description: "logged", customerAddress: "1 A St, Houston, TX", customerName: "Ana", jobStatus: "Done" });
    await job({ date: "2026-10-01", description: "old", customerAddress: "2 B St.", customerName: "Ben", customerPhone: "555-0199" });
    const items = [
      event("PS5 HDMI", "15:00", "16:30", "2 B St, Houston, TX 77002, USA"),
      event("Xbox clean", "09:00", "10:00", "1 A St, Houston, TX 77002"),
      event("Dentist", "12:00", "13:00"),
      event("Day off?", "00:00", "00:00", "Somewhere", { start: { date: DAY }, end: { date: "2026-11-21" } }),
      event("Cancelled", "11:00", "12:00", "9 Z St", { status: "cancelled" })
    ];
    const { stops, unrouted } = await calendarStops(account._id, DAY, { fetchCalendarItems: async () => items });

    expect(stops.map((stop) => [stop.order, stop.title, stop.scheduledTime, stop.minutes])).toEqual([
      [1, "Xbox clean", "09:00", 60],
      [2, "PS5 HDMI", "15:00", 90]
    ]);
    expect(stops[0].entryId).toEqual(expect.any(String));
    expect(stops[0]).toMatchObject({ customerName: "Ana", lat: null, lng: null });
    expect(stops[1]).toMatchObject({ entryId: null, customerName: "Ben", customerPhone: "555-0199" });
    expect(unrouted).toEqual([{ title: "Dentist", time: "12:00" }]);
  });

  it("prices home, each stop and home again in one batch", async () => {
    const stops = [
      { _id: "a", order: 1, address: "1 A St", scheduledTime: "09:00", minutes: 60 },
      { _id: "b", order: 2, address: "2 B St", scheduledTime: "15:00", minutes: 60 }
    ];
    let asked = [];
    const plan = await routePlan(
      { date: DAY, stops, settings: { homeBase: "Home", bufferMinutes: 10, homeBy: "" } },
      { getDriveMatrix: async (legs) => { asked = legs; return legs.map(() => ({ minutes: 20 })); } }
    );
    expect(asked.map((leg) => `${leg.from} > ${leg.to}`)).toEqual(["Home > 1 A St", "1 A St > 2 B St", "2 B St > Home"]);
    expect(plan).toMatchObject({ leaveHomeBy: "8:30 AM", totalDriveMin: 60 });
  });

  it("answers by route: calendar stops only for the calendar's owner, never drives with drives=0", async () => {
    vi.mocked(listDayEvents).mockResolvedValue([event("Xbox clean", "09:00", "10:00", "1 A St")]);

    // Not the owner: an empty route, and the calendar is never read.
    const other = await authed(request(app).get(`/api/entries/route-plan?date=${DAY}`));
    expect(other.body).toMatchObject({ date: DAY, calendarAvailable: false, stops: [] });
    expect(listDayEvents).not.toHaveBeenCalled();

    process.env.GOOGLE_CALENDAR_ACCOUNT_ID = String(account._id);
    process.env.GOOGLE_MAPS_API_KEY = "test-key";
    const home = await authed(request(app).get(`/api/entries/route-plan?date=${DAY}&drives=0`));
    expect(home.body).toMatchObject({ calendarAvailable: true, drivesAvailable: false, warnings: [] });
    expect(home.body.stops.map((stop) => stop.title)).toEqual(["Xbox clean"]);

    // The calendar failing still answers, with the reason.
    vi.mocked(listDayEvents).mockRejectedValueOnce(new Error("Google Calendar request failed."));
    const down = await authed(request(app).get(`/api/entries/route-plan?date=${DAY}&drives=0`));
    expect(down.body).toMatchObject({ calendarAvailable: false, stops: [], warnings: ["Google Calendar request failed."] });

    const day = await authed(request(app).get(`/api/entries/today?date=${DAY}`));
    expect(day.status).toBe(200);
    expect((await authed(request(app).get("/api/entries/today?date=tomorrow"))).status).toBe(400);
    expect((await authed(request(app).get("/api/entries/route-plan?date=2026-13-40"))).status).toBe(400);
  });
});
