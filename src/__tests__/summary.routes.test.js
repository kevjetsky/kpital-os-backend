// GET /api/entries/summary computes the dashboard's headline numbers in Mongo
// so the client stops downloading every entry to add up four totals. These
// tests pin the arithmetic, the inclusive range boundaries, and — because this
// is a new read path over financial data — that it stays scoped to one account.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";

let mongod;
let accountA;
let accountB;
let tokenA;
let tokenB;

function tokenFor(accountId) {
  return jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, {
    expiresIn: "1h"
  });
}

function entry(accountId, date, overrides = {}) {
  return {
    accountId,
    date: new Date(date),
    type: "Repair",
    description: "job",
    income: 100,
    expense: 40,
    salesTax: 8,
    netProfit: 60,
    status: "Paid",
    ...overrides
  };
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());

  const passwordHash = await bcrypt.hash("password123", 10);
  const a = await Settings.create({
    key: "main", email: "a@test.com", passwordHash, emailVerified: true
  });
  const b = await Settings.create({
    key: "account-b", email: "b@test.com", passwordHash, emailVerified: true
  });
  accountA = a._id;
  accountB = b._id;
  tokenA = tokenFor(accountA);
  tokenB = tokenFor(accountB);
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await Entry.deleteMany({}).setOptions({ allowCrossAccount: true });
});

const get = (query, token = tokenA) =>
  request(app).get(`/api/entries/summary${query}`).set("Authorization", `Bearer ${token}`);

describe("GET /api/entries/summary", () => {
  it("sums the money columns over the requested range", async () => {
    await Entry.insertMany([
      entry(accountA, "2026-06-10", { income: 100, expense: 40, salesTax: 8, netProfit: 60 }),
      entry(accountA, "2026-06-20", { income: 250, expense: 50, salesTax: 20, netProfit: 200 })
    ]);

    const res = await get("?from=2026-06-01&to=2026-06-30");

    expect(res.status).toBe(200);
    expect(res.body.range).toMatchObject({
      income: 350, expense: 90, salesTax: 28, net: 260, count: 2
    });
  });

  it("reports owner draws on their own line, outside expense and profit", async () => {
    await Entry.insertMany([
      entry(accountA, "2026-06-10", { income: 1000, expense: 100, salesTax: 82.5, netProfit: 817.5 }),
      // A draw as it is now stored: real cash out, netProfit pinned to 0.
      entry(accountA, "2026-06-22", {
        type: "Owner Draw",
        description: "Owner withdrawal",
        income: 0,
        expense: 300,
        salesTax: 0,
        netProfit: 0
      })
    ]);

    const res = await get("?from=2026-06-01&to=2026-06-30");

    expect(res.status).toBe(200);
    // The draw is not a business cost, so it stays out of Expense entirely...
    expect(res.body.range.expense).toBe(100);
    // ...and out of profit, which is the bug this type was added to fix.
    expect(res.body.range.net).toBe(817.5);
    // But it is still reported, so cash out reconciles.
    expect(res.body.range.ownerDraws).toBe(300);
    expect(res.body.range.count).toBe(2);
  });

  it("reports zero owner draws for a period with none", async () => {
    await Entry.insertMany([entry(accountA, "2026-06-10")]);

    const res = await get("?from=2026-06-01&to=2026-06-30");

    expect(res.body.range.ownerDraws).toBe(0);
  });

  it("includes records on both the first and last day of the range", async () => {
    await Entry.insertMany([
      entry(accountA, "2026-05-31", { income: 1 }), // just outside
      entry(accountA, "2026-06-01", { income: 10 }), // first day
      entry(accountA, "2026-06-30", { income: 20 }), // last day
      entry(accountA, "2026-07-01", { income: 100 }) // just outside
    ]);

    const res = await get("?from=2026-06-01&to=2026-06-30");

    expect(res.body.range.count).toBe(2);
    expect(res.body.range.income).toBe(30);
  });

  it("counts records by status across the whole account, not just the range", async () => {
    await Entry.insertMany([
      entry(accountA, "2026-06-10", { status: "Pending" }),
      entry(accountA, "2026-06-11", { status: "Pending" }),
      entry(accountA, "2026-06-12", { status: "Completed" }),
      entry(accountA, "2026-06-13", { status: "Paid" }),
      // Outside the range, but still an open record the action cards must show.
      entry(accountA, "2020-01-01", { status: "Pending" })
    ]);

    const res = await get("?from=2026-06-01&to=2026-06-30");

    expect(res.body.statusCounts).toEqual({ Pending: 3, Completed: 1, Paid: 1 });
    expect(res.body.totalRecords).toBe(5);
    expect(res.body.pendingRecords).toBe(3);
    expect(res.body.unpaidRecords).toBe(4); // everything that is not Paid
  });

  it("totals sales tax for the requested quarter", async () => {
    await Entry.insertMany([
      entry(accountA, "2026-04-01", { salesTax: 5 }), // Q2 start
      entry(accountA, "2026-06-30", { salesTax: 7 }), // Q2 end
      entry(accountA, "2026-07-01", { salesTax: 99 }), // Q3
      entry(accountA, "2026-03-31", { salesTax: 99 }) // Q1
    ]);

    const res = await get("?from=2026-01-01&to=2026-12-31&year=2026&quarter=2");

    expect(res.body.quarter).toEqual({ year: 2026, quarter: 2, salesTax: 12 });
  });

  it("returns zeroes rather than nulls for an empty account", async () => {
    const res = await get("?from=2026-06-01&to=2026-06-30");

    expect(res.status).toBe(200);
    expect(res.body.range).toMatchObject({
      income: 0, expense: 0, salesTax: 0, net: 0, count: 0
    });
    expect(res.body.quarter.salesTax).toBe(0);
    expect(res.body.unpaidRecords).toBe(0);
  });

  it("never mixes in another account's records", async () => {
    await Entry.insertMany([
      entry(accountA, "2026-06-10", { income: 100, salesTax: 8, status: "Pending" }),
      entry(accountB, "2026-06-10", { income: 999, salesTax: 999, status: "Pending" }),
      entry(accountB, "2026-06-11", { income: 999, salesTax: 999, status: "Paid" })
    ]);

    const resA = await get("?from=2026-06-01&to=2026-06-30&year=2026&quarter=2");
    expect(resA.body.range.income).toBe(100);
    expect(resA.body.totalRecords).toBe(1);
    expect(resA.body.quarter.salesTax).toBe(8);

    const resB = await get("?from=2026-06-01&to=2026-06-30&year=2026&quarter=2", tokenB);
    expect(resB.body.range.income).toBe(1998);
    expect(resB.body.totalRecords).toBe(2);
  });

  it("rejects a malformed range", async () => {
    expect((await get("?from=not-a-date&to=2026-06-30")).status).toBe(400);
    expect((await get("?from=2026-06-30&to=2026-06-01")).status).toBe(400);
  });

  it("rejects an out-of-range quarter", async () => {
    expect((await get("?from=2026-01-01&to=2026-12-31&quarter=5")).status).toBe(400);
    expect((await get("?from=2026-01-01&to=2026-12-31&quarter=0")).status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/entries/summary?from=2026-06-01&to=2026-06-30");
    expect(res.status).toBe(401);
  });

  it("is not shadowed by the /:id routes", async () => {
    // /summary must resolve to the aggregate, not be parsed as an entry id.
    const res = await get("?from=2026-06-01&to=2026-06-30");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("statusCounts");
  });
});
