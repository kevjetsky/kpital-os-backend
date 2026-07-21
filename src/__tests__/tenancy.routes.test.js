// Proves data isolation between accounts — the property the whole accountId
// migration exists to guarantee. If any of these fail, one business can read or
// mutate another's financial records.
//
// Tokens are minted directly rather than obtained via /api/auth/login because
// login still resolves the single Settings{key:"main"} document; multi-account
// login lands with account creation (Phase 2).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryServer } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";

let mongod;
let passwordHash;
let accountA;
let accountB;
let tokenA;
let tokenB;

function tokenFor(accountId) {
  return jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });
}

const authed = (req, token) => req.set("Authorization", `Bearer ${token}`);

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
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
  accountA = await Settings.create({
    key: "main",
    email: "a@example.com",
    emailVerified: true,
    passwordHash,
  });
  // A second business. `key` is still unique per document, which is exactly the
  // singleton constraint account creation has to relax.
  accountB = await Settings.create({
    key: "account-b",
    email: "b@example.com",
    emailVerified: true,
    passwordHash,
  });
  tokenA = tokenFor(accountA._id);
  tokenB = tokenFor(accountB._id);
});

async function createEntry(token, overrides = {}) {
  const res = await authed(request(app).post("/api/entries"), token).send({
    type: "Repair",
    date: "2026-06-01",
    description: "HDMI port replacement",
    income: 120,
    customerPhone: "555-0101",
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.body;
}

describe("account isolation", () => {
  it("lists only the requesting account's entries", async () => {
    await createEntry(tokenA, { description: "A job" });
    await createEntry(tokenB, { description: "B job" });

    const resA = await authed(request(app).get("/api/entries"), tokenA);
    const resB = await authed(request(app).get("/api/entries"), tokenB);

    expect(resA.body).toHaveLength(1);
    expect(resB.body).toHaveLength(1);
    expect(resA.body[0].description).toBe("A job");
    expect(resB.body[0].description).toBe("B job");
  });

  it("cannot read another account's entry by id", async () => {
    const entryB = await createEntry(tokenB, { description: "B job" });
    const res = await authed(request(app).get("/api/entries"), tokenA);
    expect(res.body.map((e) => e._id)).not.toContain(entryB._id);
  });

  it("cannot update another account's entry", async () => {
    const entryB = await createEntry(tokenB, { description: "B job" });
    const res = await authed(request(app).put(`/api/entries/${entryB._id}`), tokenA).send({
      description: "hijacked",
    });
    expect(res.status).toBe(404);

    // And the record is genuinely untouched, not just reported as missing.
    const check = await authed(request(app).get("/api/entries"), tokenB);
    expect(check.body[0].description).toBe("B job");
  });

  it("cannot delete another account's entry", async () => {
    const entryB = await createEntry(tokenB, { description: "B job" });
    const res = await authed(request(app).delete(`/api/entries/${entryB._id}`), tokenA);
    expect(res.status).toBe(404);

    const check = await authed(request(app).get("/api/entries"), tokenB);
    expect(check.body).toHaveLength(1);
  });

  it("keeps customers and products separate", async () => {
    await createEntry(tokenA, { customerPhone: "555-1111" });
    await createEntry(tokenB, { customerPhone: "555-2222" });

    const resA = await authed(request(app).get("/api/reference-options"), tokenA);
    const resB = await authed(request(app).get("/api/reference-options"), tokenB);

    const phonesA = resA.body.customers.map((c) => c.phone);
    const phonesB = resB.body.customers.map((c) => c.phone);
    expect(phonesA).toContain("555-1111");
    expect(phonesA).not.toContain("555-2222");
    expect(phonesB).toContain("555-2222");
    expect(phonesB).not.toContain("555-1111");
  });

  it("allows both accounts to use the same inventory SKU", async () => {
    const itemA = await authed(request(app).post("/api/inventory"), tokenA).send({
      name: "HDMI Port",
      sku: "HDMI-V21",
      quantity: 5,
    });
    const itemB = await authed(request(app).post("/api/inventory"), tokenB).send({
      name: "HDMI Port",
      sku: "HDMI-V21",
      quantity: 9,
    });

    // Pre-tenancy the SKU index was globally unique, so this would 409.
    expect(itemA.status).toBe(201);
    expect(itemB.status).toBe(201);

    const listA = await authed(request(app).get("/api/inventory"), tokenA);
    expect(listA.body).toHaveLength(1);
    expect(listA.body[0].quantity).toBe(5);
  });

  it("keeps inventory adjustments from crossing accounts", async () => {
    const itemB = await authed(request(app).post("/api/inventory"), tokenB).send({
      name: "Stick Module",
      sku: "STICK-1",
      quantity: 10,
    });

    const res = await authed(
      request(app).post(`/api/inventory/${itemB.body._id}/adjust`),
      tokenA
    ).send({ type: "out", quantity: 5, reason: "cross-account attempt" });
    expect(res.status).toBe(404);

    const check = await authed(request(app).get("/api/inventory"), tokenB);
    expect(check.body[0].quantity).toBe(10);
  });

  it("scopes tax liability per account", async () => {
    await createEntry(tokenA, { type: "Sales", income: 100, date: "2026-02-01" });

    const resA = await authed(request(app).get("/api/tax/liability?year=2026"), tokenA);
    const resB = await authed(request(app).get("/api/tax/liability?year=2026"), tokenB);

    expect(resA.body.totals.collected).toBeGreaterThan(0);
    expect(resB.body.totals.collected).toBe(0);
  });

  it("rejects a pre-tenancy token that carries no accountId", async () => {
    const legacyToken = jwt.sign({ role: "owner" }, process.env.JWT_SECRET, { expiresIn: "1h" });
    const res = await authed(request(app).get("/api/entries"), legacyToken);
    expect(res.status).toBe(401);
  });
});
