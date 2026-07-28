import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";

let mongod;
let token;
let passwordHash;

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
  await mongoose.connection.dropDatabase();
  await Settings.create({
    key: "main",
    email: "owner@example.com",
    emailVerified: true,
    passwordHash
  });
  const login = await request(app)
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password: "password123" });
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
    income: 100,
    customerPhone: "555-0101",
    ...overrides
  });
  expect(res.status).toBe(201);
  return res.body;
}

async function createRefund(overrides = {}) {
  const res = await authed(request(app).post("/api/entries")).send({
    type: "Refund",
    date: "2026-06-05",
    description: "Refund — HDMI port replacement",
    expense: 100,
    ...overrides
  });
  return res;
}

describe("refunds", () => {
  it("links a refund to the record it reverses and cancels that record out", async () => {
    const original = await createRepair();
    expect(original.salesTax).toBe(8.25);

    const res = await createRefund({ refundOf: original._id });
    expect(res.status).toBe(201);
    expect(res.body.refundOf).toBe(original._id);
    expect(res.body.salesTax).toBe(-8.25);
    expect(original.netProfit + res.body.netProfit).toBe(0);
  });

  it("reverses only the share of tax a partial refund gives back", async () => {
    const original = await createRepair();
    const res = await createRefund({ refundOf: original._id, expense: 40 });
    expect(res.status).toBe(201);
    expect(res.body.salesTax).toBe(-3.3);
  });

  it("reverses the rate the original charged, not today's rate", async () => {
    // Booked back when the account charged 10%.
    const original = await createRepair({ taxRate: 0.1 });
    expect(original.salesTax).toBe(10);

    const res = await createRefund({ refundOf: original._id, taxRate: 0.0825 });
    expect(res.status).toBe(201);
    expect(res.body.salesTax).toBe(-10);
  });

  it("falls back to the current rate when the refund has nothing to point at", async () => {
    const res = await createRefund();
    expect(res.status).toBe(201);
    expect(res.body.refundOf).toBeNull();
    expect(res.body.salesTax).toBe(-8.25);
  });

  it("refuses to link a refund to a record that never took money in", async () => {
    const expense = await authed(request(app).post("/api/entries")).send({
      type: "Expenses",
      date: "2026-06-01",
      description: "Gas",
      expense: 60
    });
    expect(expense.status).toBe(201);

    const res = await createRefund({ refundOf: expense.body._id });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/took money in/i);
  });

  it("refuses a link to another account's record", async () => {
    const res = await createRefund({ refundOf: new mongoose.Types.ObjectId().toString() });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not found/i);
  });

  it("reports the refund on the original record when listing entries", async () => {
    const original = await createRepair();
    const refund = await createRefund({ refundOf: original._id, expense: 40 });

    const list = await authed(request(app).get("/api/entries"));
    expect(list.status).toBe(200);

    const listedOriginal = list.body.find((entry) => entry._id === original._id);
    expect(listedOriginal.refundedTotal).toBe(40);
    expect(listedOriginal.refunds).toHaveLength(1);
    expect(listedOriginal.refunds[0]._id).toBe(refund.body._id);

    const listedRefund = list.body.find((entry) => entry._id === refund.body._id);
    expect(listedRefund.refundOfEntry.description).toBe("HDMI port replacement");
  });

  it("drops the link when a refund is retyped into something else", async () => {
    const original = await createRepair();
    const refund = await createRefund({ refundOf: original._id });

    const res = await authed(request(app).put(`/api/entries/${refund.body._id}`)).send({
      type: "Expenses",
      description: "Actually just an expense",
      income: 0,
      expense: 100
    });
    expect(res.status).toBe(200);
    expect(res.body.refundOf).toBeNull();
    expect(res.body.salesTax).toBe(0);
  });

  it("keeps the refund but clears the link when the original is deleted", async () => {
    const original = await createRepair();
    const refund = await createRefund({ refundOf: original._id });

    const del = await authed(request(app).delete(`/api/entries/${original._id}`));
    expect(del.status).toBe(200);

    const list = await authed(request(app).get("/api/entries"));
    const listedRefund = list.body.find((entry) => entry._id === refund.body._id);
    expect(listedRefund).toBeDefined();
    expect(listedRefund.refundOf).toBeNull();
  });

  it("offers money-in records as refund candidates with what is already refunded", async () => {
    const original = await createRepair();
    await createRefund({ refundOf: original._id, expense: 30 });
    await authed(request(app).post("/api/entries")).send({
      type: "Expenses",
      date: "2026-06-02",
      description: "Gas",
      expense: 60
    });

    const res = await authed(request(app).get("/api/entries/refund-candidates"));
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0]._id).toBe(original._id);
    expect(res.body.candidates[0].refundedTotal).toBe(30);
  });

  it("scopes refund candidates to the customer being refunded", async () => {
    await createRepair();
    const other = await createRepair({ customerPhone: "555-0202", description: "Disc drive swap" });

    const res = await authed(
      request(app).get("/api/entries/refund-candidates").query({ phone: "555-0202" })
    );
    expect(res.status).toBe(200);
    expect(res.body.candidates).toHaveLength(1);
    expect(res.body.candidates[0]._id).toBe(other._id);
  });
});
