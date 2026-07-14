import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app.js";

let mongod;
let token;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await request(app).post("/api/auth/setup").send({ password: "password123" });
  const login = await request(app).post("/api/auth/login").send({ password: "password123" });
  token = login.body.token;
});

function authed(req) {
  return req.set("Authorization", `Bearer ${token}`);
}

async function createRepair(overrides = {}) {
  const res = await authed(request(app).post("/api/entries")).send({
    type: "Repair",
    date: "2026-06-01",
    description: "HDMI port replacement",
    income: 120,
    customerPhone: "555-0101",
    ...overrides
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("warranty callbacks", () => {
  it("creates a callback entry linked to the original job", async () => {
    const original = await createRepair();
    const res = await authed(request(app).post("/api/entries")).send({
      type: "Repair",
      date: "2026-06-20",
      description: "Rework: port loose again",
      income: 0,
      customerPhone: "555-0101",
      callbackOf: original._id,
      callbackReason: "Port failed again"
    });
    expect(res.status).toBe(201);
    expect(res.body.isWarrantyCallback).toBe(true);
    expect(String(res.body.callbackOf)).toBe(String(original._id));
    expect(res.body.callbackReason).toBe("Port failed again");
  });

  it("rejects callbackOf pointing to a missing entry", async () => {
    const res = await authed(request(app).post("/api/entries")).send({
      type: "Repair",
      date: "2026-06-20",
      description: "Rework",
      customerPhone: "555-0101",
      callbackOf: new mongoose.Types.ObjectId().toString()
    });
    expect(res.status).toBe(400);
  });

  it("rejects an entry set as a callback of itself on update", async () => {
    const original = await createRepair();
    const res = await authed(request(app).put(`/api/entries/${original._id}`)).send({
      callbackOf: original._id
    });
    expect(res.status).toBe(400);
  });

  it("clears the link when isWarrantyCallback is turned off", async () => {
    const original = await createRepair();
    const cb = await createRepair({
      date: "2026-06-15",
      description: "Rework",
      callbackOf: original._id
    });
    const res = await authed(request(app).put(`/api/entries/${cb._id}`)).send({
      isWarrantyCallback: false
    });
    expect(res.status).toBe(200);
    expect(res.body.isWarrantyCallback).toBe(false);
    expect(res.body.callbackOf).toBeNull();
    expect(res.body.callbackReason).toBe("");
  });

  it("finds warranty candidates for a returning customer by phone", async () => {
    const original = await createRepair();
    const res = await authed(
      request(app).get("/api/entries/warranty-candidates")
    ).query({ phone: "555-0101", date: "2026-06-20" });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(String(res.body.candidates[0]._id)).toBe(String(original._id));
  });

  it("returns no candidates outside the 40-day window", async () => {
    await createRepair({ date: "2026-01-01" });
    const res = await authed(
      request(app).get("/api/entries/warranty-candidates")
    ).query({ phone: "555-0101", date: "2026-06-20" });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(0);
  });

  it("meters callback rate, cost, and days-to-failure", async () => {
    const original = await createRepair();
    await createRepair({ date: "2026-06-05", customerPhone: "555-0202", description: "Screen swap" });
    await authed(request(app).post("/api/entries")).send({
      type: "Repair",
      date: "2026-06-21",
      description: "Rework: port loose again",
      income: 0,
      expense: 12,
      customerPhone: "555-0101",
      callbackOf: original._id,
      callbackReason: "Port failed again"
    });

    const res = await authed(
      request(app).get("/api/entries/callback-stats")
    ).query({ from: "2026-06-01", to: "2026-06-30" });
    expect(res.status).toBe(200);
    expect(res.body.totalRepairs).toBe(2);
    expect(res.body.callbackCount).toBe(1);
    expect(res.body.callbackRate).toBe(0.5);
    expect(res.body.callbackTotalExpense).toBe(12);
    expect(res.body.medianDaysToCallback).toBe(20);
    expect(res.body.byRepairType[0].name).toBe("(unspecified)");
    expect(res.body.recentCallbacks).toHaveLength(1);
  });

  it("filters the entries list to callbacks only", async () => {
    const original = await createRepair();
    await createRepair({ date: "2026-06-15", description: "Rework", callbackOf: original._id });
    const res = await authed(request(app).get("/api/entries")).query({ callbacks: "true" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].isWarrantyCallback).toBe(true);
  });
});
