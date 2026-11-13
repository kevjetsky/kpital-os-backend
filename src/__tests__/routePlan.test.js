// A day's route: the order of the stops, the drives between them, and whether
// each can be reached in time.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";
import { planDay, routePlan } from "../insights/routePlan.js";

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

describe("the day's stops and their drives", () => {
  it("orders stops by time, then as booked, prices each leg once, and skips jobs with no address", async () => {
    await job({ description: "late", customerAddress: "2 B St", scheduledTime: "15:00" });
    await job({ description: "untimed", customerAddress: "3 C St", customerPhone: "555-0102" });
    await job({ description: "early", customerAddress: "1 A St", scheduledTime: "09:00", customerPhone: "555-0103" });
    await job({ description: "nowhere", scheduledTime: "12:00", customerPhone: "555-0104" });
    await job({ description: "other day", date: "2026-11-21", customerAddress: "9 Z St", customerPhone: "555-0105" });

    let asked = [];
    const plan = await routePlan(
      { accountId: account._id, date: DAY, settings: { homeBase: "Home", bufferMinutes: 10, homeBy: "" } },
      { getDriveMatrix: async (legs) => { asked = legs; return legs.map(() => ({ minutes: 20 })); } }
    );
    expect(plan.stops.map((stop) => stop.address)).toEqual(["1 A St", "2 B St", "3 C St"]);
    expect(asked.map((leg) => `${leg.from} > ${leg.to}`)).toEqual(["Home > 1 A St", "1 A St > 2 B St", "2 B St > 3 C St", "3 C St > Home"]);
    expect(plan).toMatchObject({ leaveHomeBy: "8:30 AM", totalDriveMin: 80 });
  });

  it("answers by route: stops for any day, and drives only for the account that owns the allowance", async () => {
    await job({ customerAddress: "1 A St", scheduledTime: "09:00" });
    const plan = await authed(request(app).get(`/api/entries/route-plan?date=${DAY}`));
    expect(plan.status).toBe(200);
    expect(plan.body).toMatchObject({ date: DAY, drivesAvailable: false, warnings: [] });
    expect(plan.body.stops).toHaveLength(1);

    const day = await authed(request(app).get(`/api/entries/today?date=${DAY}`));
    expect(day.body).toMatchObject({ date: DAY, todayCount: 1 });
    expect((await authed(request(app).get("/api/entries/today?date=tomorrow"))).status).toBe(400);
    expect((await authed(request(app).get("/api/entries/route-plan?date=2026-13-40"))).status).toBe(400);
  });
});
