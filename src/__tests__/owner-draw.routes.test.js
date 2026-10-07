// Owner Draw is a capital distribution, not a deductible expense. These tests
// pin the behaviour that makes it worth having as its own type: the cash leaves
// the account but net profit does not move, and none of the customer-facing
// rules that apply to real work apply to the owner paying themselves.

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

function postEntry(body) {
  return authed(request(app).post("/api/entries")).send(body);
}

const draw = (overrides = {}) => ({
  type: "Owner Draw",
  date: "2026-09-01",
  description: "Owner withdrawal",
  expense: 650,
  status: "Paid",
  paymentMethod: "Zelle",
  ...overrides
});

describe("POST /api/entries — Owner Draw", () => {
  it("books the cash out without touching net profit", async () => {
    const res = await postEntry(draw());

    expect(res.status).toBe(201);
    // The money really left the account...
    expect(res.body.expense).toBe(650);
    // ...but a member distribution is not a business expense, so profit holds.
    expect(res.body.netProfit).toBe(0);
    expect(res.body.salesTax).toBe(0);
  });

  it("does not require a customer, unlike Repair and Sales", async () => {
    const res = await postEntry(draw());
    expect(res.status).toBe(201);
    expect(res.body.customerName).toBe("");
    expect(res.body.customerOptionId).toBeNull();
  });

  it("still requires a payment method to be marked Paid", async () => {
    const res = await postEntry(draw({ paymentMethod: undefined }));

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/payment method/i);
  });

  it("keeps no expense category, since a draw is not a categorized cost", async () => {
    const res = await postEntry(draw({ category: "Rent" }));

    expect(res.status).toBe(201);
    expect(res.body.category).toBe("");
  });

  it("leaves the same amount booked as Payroll reducing profit", async () => {
    const wage = await postEntry({
      type: "Payroll",
      date: "2026-09-01",
      description: "Assistant wages",
      expense: 650,
      status: "Paid",
      paymentMethod: "Zelle"
    });

    // The contrast is the whole point: a real wage is deductible, a draw is not.
    expect(wage.status).toBe(201);
    expect(wage.body.netProfit).toBe(-650);
  });
});

describe("PUT /api/entries/:id — retyping to Owner Draw", () => {
  it("recomputes a mis-booked Payroll withdrawal to zero profit impact", async () => {
    const created = await postEntry({
      type: "Payroll",
      date: "2026-08-22",
      description: "Owner withdrawal",
      expense: 300,
      status: "Paid",
      paymentMethod: "Zelle"
    });
    expect(created.body.netProfit).toBe(-300);

    const res = await authed(
      request(app).put(`/api/entries/${created.body._id}`)
    ).send({ type: "Owner Draw" });

    expect(res.status).toBe(200);
    expect(res.body.type).toBe("Owner Draw");
    expect(res.body.expense).toBe(300);
    expect(res.body.netProfit).toBe(0);
  });
});

describe("GET /api/entries/summary — with draws", () => {
  it("splits draws out of expenses while profit stays whole", async () => {
    await postEntry({
      type: "Sales",
      date: "2026-09-01",
      description: "Controller sale",
      income: 1000,
      status: "Paid",
      paymentMethod: "Cash",
      customerPhone: "555-0199"
    });
    await postEntry({
      type: "Expenses",
      date: "2026-09-01",
      description: "Heat gun",
      expense: 100,
      status: "Paid",
      paymentMethod: "Card"
    });
    await postEntry(draw());

    const res = await authed(
      request(app).get("/api/entries/summary?from=2026-09-01&to=2026-09-30")
    );

    expect(res.status).toBe(200);
    expect(res.body.range.income).toBe(1000);
    // Only the heat gun is a business cost; the $650 draw is not.
    expect(res.body.range.expense).toBe(100);
    expect(res.body.range.ownerDraws).toBe(650);
    // 1000 - 100; the $82.50 tax sits on top of the price, not in profit. The
    // draw does not appear here at all.
    expect(res.body.range.net).toBe(900);
  });
});
