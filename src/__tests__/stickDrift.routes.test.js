// Stick Drift work orders through the HTTP routes: the public website API (validation, CORS, rate
// limiting) and the owner API (status rules, notes, tracking, tenancy).
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const { default: app } = await import("../app.js");
const { Settings } = await import("../models/Settings.js");
const { Entry } = await import("../models/Entry.js");
const { InventoryItem } = await import("../models/InventoryItem.js");
const { StickDriftWorkOrder } = await import("../models/StickDriftWorkOrder.js");
const { CREATE_LIMIT, READ_LIMIT } = await import("../routes/stickDrift.js");

const SITE = "https://wefixstickdrift.com";
const RECEIVING = { name: "We Fix Stick Drift", street: "500 Repair Ln", city: "Houston", state: "TX", zip: "77002" };

let mongod;
let account;
let token;
let otherToken;
let ipSeq = 0;

const body = () => ({
  customer: { firstName: "  Jane ", lastName: "Gamer", phone: "(512) 555-0142", email: "Jane@Example.com" },
  returnAddress: { street1: " 100 Congress Ave ", street2: "Apt 4", city: "Austin", state: "tx", zip: "78701" },
  controller: { model: "PS5 DualSense", quantity: 2 },
});

// The limiter is live in tests, so every request gets its own IP unless a test pins one.
const freshIp = () => `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq++ & 255}`;
const pub = (method, path = "", ip = freshIp()) =>
  request(app)[method](`/api/public/stick-drift/work-orders${path}`).set("X-Appengine-User-IP", ip);
const admin = (method, path = "", t = token) =>
  request(app)[method](`/api/stick-drift/work-orders${path}`).set("Authorization", `Bearer ${t}`);

async function place(overrides = {}) {
  const res = await pub("post").send({ ...body(), ...overrides });
  expect(res.status).toBe(201);
  return res.body;
}

const setStatus = (number, status, extra = {}) => admin("post", `/${number}/status`).send({ status, ...extra });

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.SITE_URL = `${SITE}/`;
  process.env.RECEIVING_ADDRESS = JSON.stringify(RECEIVING);
  delete process.env.PRICE_CENTS;
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await StickDriftWorkOrder.syncIndexes();
  process.env.RECEIVING_ADDRESS = JSON.stringify(RECEIVING);
  delete process.env.PRICE_CENTS;
  account = await Settings.create({ key: "main", email: "kev@example.com", emailVerified: true, passwordHash: "x" });
  const other = await Settings.create({ key: "other", email: "other@example.com", emailVerified: true, passwordHash: "x" });
  process.env.STICK_DRIFT_ACCOUNT_ID = String(account._id);
  token = jwt.sign({ role: "owner", accountId: String(account._id) }, process.env.JWT_SECRET);
  otherToken = jwt.sign({ role: "owner", accountId: String(other._id) }, process.env.JWT_SECRET);
});

describe("POST /api/public/stick-drift/work-orders", () => {
  it("creates a label_created work order and returns only the number and token", async () => {
    const res = await pub("post").send(body());
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(["token", "workOrderNumber"]);
    expect(res.body.workOrderNumber).toBe("WFSD-1001");
    // 32 random bytes, URL-safe.
    expect(res.body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(res.body.token, "base64url")).toHaveLength(32);

    const saved = await StickDriftWorkOrder.findOne({ accountId: account._id, workOrderNumber: "WFSD-1001" }).lean();
    expect(saved.status).toBe("label_created");
    expect(saved.customer).toEqual({ firstName: "Jane", lastName: "Gamer", phone: "+15125550142", email: "jane@example.com" });
    expect(saved.returnAddress).toEqual({ street1: "100 Congress Ave", street2: "Apt 4", city: "Austin", state: "TX", zip: "78701" });
    expect(saved.controller).toEqual({ model: "PS5 DualSense", quantity: 2 });
    expect(saved.priceCents).toBe(9998);
    expect(saved.statusHistory).toHaveLength(1);
    expect(saved.statusHistory[0]).toMatchObject({ from: null, to: "label_created" });
    expect(saved.notes).toEqual([]);
    expect(saved.createdAt).toBeInstanceOf(Date);
    expect(saved.updatedAt).toBeInstanceOf(Date);
  });

  it("numbers work orders upward with no duplicates under concurrency, each with its own token", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => place()));
    const numbers = results.map((r) => r.workOrderNumber).sort();
    expect(numbers).toEqual(["WFSD-1001", "WFSD-1002", "WFSD-1003", "WFSD-1004", "WFSD-1005", "WFSD-1006", "WFSD-1007", "WFSD-1008"]);
    expect(new Set(results.map((r) => r.token)).size).toBe(8);
  });

  it("saves the price at creation from PRICE_CENTS x quantity", async () => {
    process.env.PRICE_CENTS = "5999";
    const { workOrderNumber } = await place({ controller: { model: "Xbox Series X|S", quantity: 3 } });
    process.env.PRICE_CENTS = "100";
    const res = await admin("get", `/${workOrderNumber}`);
    expect(res.body.priceCents).toBe(17997);
  });

  it("accepts a missing or blank email", async () => {
    const b = body();
    delete b.customer.email;
    expect((await pub("post").send(b)).status).toBe(201);
    b.customer.email = "";
    expect((await pub("post").send(b)).status).toBe(201);
  });

  it("drops fields the form should not set", async () => {
    const { workOrderNumber } = await place({ status: "delivered", priceCents: 1, token: "x", workOrderNumber: "WFSD-1", accountId: "000000000000000000000009" });
    const saved = await StickDriftWorkOrder.findOne({ accountId: account._id, workOrderNumber }).lean();
    expect(saved.status).toBe("label_created");
    expect(saved.priceCents).toBe(9998);
    expect(saved.token).not.toBe("x");
  });

  it.each([
    ["missing first name", (b) => { b.customer.firstName = "   "; }, /first name/i],
    ["missing last name", (b) => { delete b.customer.lastName; }, null],
    ["missing phone", (b) => { delete b.customer.phone; }, null],
    ["bad phone", (b) => { b.customer.phone = "555-0142"; }, /phone/i],
    ["bad email", (b) => { b.customer.email = "not-an-email"; }, /email/i],
    ["missing street", (b) => { b.returnAddress.street1 = ""; }, /street/i],
    ["missing city", (b) => { b.returnAddress.city = " "; }, /city/i],
    ["territory, not a state", (b) => { b.returnAddress.state = "PR"; }, /state/i],
    ["bad zip", (b) => { b.returnAddress.zip = "7870"; }, /zip/i],
    ["unknown model", (b) => { b.controller.model = "Switch Joy-Con"; }, /model/i],
    ["quantity 0", (b) => { b.controller.quantity = 0; }, null],
    ["quantity 100", (b) => { b.controller.quantity = 100; }, null],
    ["fractional quantity", (b) => { b.controller.quantity = 1.5; }, null],
    ["quantity as a string", (b) => { b.controller.quantity = "2"; }, null],
    ["overlong name", (b) => { b.customer.firstName = "x".repeat(51); }, null],
    ["no return address", (b) => { delete b.returnAddress; }, null],
  ])("rejects %s", async (_name, mutate, message) => {
    const b = body();
    mutate(b);
    const res = await pub("post").send(b);
    expect(res.status).toBe(400);
    if (message) expect(res.body.message).toMatch(message);
    expect(await StickDriftWorkOrder.countDocuments({ accountId: account._id })).toBe(0);
  });

  it("accepts DC and Hawaii", async () => {
    await place({ returnAddress: { ...body().returnAddress, state: "DC" } });
    await place({ returnAddress: { ...body().returnAddress, state: "hi" } });
  });

  it("rejects malformed JSON and oversized bodies", async () => {
    const bad = await pub("post").set("Content-Type", "application/json").send("{nope");
    expect(bad.status).toBe(400);
    const b = body();
    b.returnAddress.street2 = "x".repeat(20_000);
    expect((await pub("post").send(b)).status).toBe(413);
  });

  it("answers 503 until it is configured", async () => {
    delete process.env.RECEIVING_ADDRESS;
    expect((await pub("post").send(body())).status).toBe(503);
    process.env.RECEIVING_ADDRESS = JSON.stringify(RECEIVING);
    delete process.env.STICK_DRIFT_ACCOUNT_ID;
    const res = await pub("post").send(body());
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("not_configured");
  });

  it("allows CORS for SITE_URL only and refuses writes from other origins", async () => {
    const preflight = await pub("options").set("Origin", SITE).set("Access-Control-Request-Method", "POST");
    expect(preflight.headers["access-control-allow-origin"]).toBe(SITE);

    const ok = await pub("post").set("Origin", SITE).send(body());
    expect(ok.status).toBe(201);
    expect(ok.headers["access-control-allow-origin"]).toBe(SITE);

    for (const origin of ["https://evil.example", "https://we-fix-consoles.com", "http://localhost:3000"]) {
      const res = await pub("post").set("Origin", origin).send(body());
      expect(res.status).toBe(403);
      expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    }
    expect(await StickDriftWorkOrder.countDocuments({ accountId: account._id })).toBe(1);
  });

  it("rate limits per IP", async () => {
    const ip = "203.0.113.7";
    for (let i = 0; i < CREATE_LIMIT; i += 1) {
      // Rejected submissions count too.
      expect((await pub("post", "", ip).send({})).status).toBe(400);
    }
    const blocked = await pub("post", "", ip).send(body());
    expect(blocked.status).toBe(429);
    expect(blocked.body.message).toMatch(/too many/i);
    expect(blocked.headers["ratelimit-remaining"] ?? blocked.headers["ratelimit"]).toBeDefined();
    // Another address is unaffected.
    expect((await pub("post", "", "203.0.113.8").send(body())).status).toBe(201);
  });

  it("never touches entries or inventory", async () => {
    const { workOrderNumber } = await place();
    await setStatus(workOrderNumber, "arrived");
    await setStatus(workOrderNumber, "repaired");
    await setStatus(workOrderNumber, "paid");
    await setStatus(workOrderNumber, "shipped_back", { returnTracking: { carrier: "USPS", number: "9400111" } });
    await setStatus(workOrderNumber, "delivered");
    expect((await admin("get", `/${workOrderNumber}`)).body.status).toBe("delivered");
    expect(await Entry.countDocuments({ accountId: account._id })).toBe(0);
    expect(await InventoryItem.countDocuments({ accountId: account._id })).toBe(0);
    const names = (await mongoose.connection.db.listCollections().toArray()).map((c) => c.name).sort();
    expect(names).toEqual(["settings", "stickDriftCounters", "stickDriftWorkOrders"]);
  });
});

describe("GET /api/public/stick-drift/work-orders/:token", () => {
  it("returns only what the label needs", async () => {
    const created = await place();
    const res = await pub("get", `/${created.token}`).set("Origin", SITE);
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(SITE);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.body).toEqual({
      workOrderNumber: "WFSD-1001",
      customerName: "Jane Gamer",
      returnAddress: { street1: "100 Congress Ave", street2: "Apt 4", city: "Austin", state: "TX", zip: "78701" },
      model: "PS5 DualSense",
      quantity: 2,
      priceCents: 9998,
      status: "label_created",
      createdAt: expect.any(String),
      shipTo: RECEIVING,
    });
  });

  it("reflects the current status", async () => {
    const created = await place();
    await setStatus(created.workOrderNumber, "arrived");
    expect((await pub("get", `/${created.token}`)).body.status).toBe("arrived");
  });

  it("does not accept the work order number, an unknown token or a malformed one", async () => {
    const created = await place();
    const unknown = `${created.token.slice(0, 42)}${created.token.endsWith("A") ? "B" : "A"}`;
    for (const value of [created.workOrderNumber, unknown, "abc", created.token.slice(0, 20), encodeURIComponent('{"$ne":""}')]) {
      const res = await pub("get", `/${value}`);
      expect(res.status).toBe(404);
      expect(res.body.message).toBe("Work order not found.");
    }
  });

  it("gives no CORS header to other origins", async () => {
    const created = await place();
    const res = await pub("get", `/${created.token}`).set("Origin", "https://evil.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });

  it("rate limits per IP", async () => {
    const created = await place();
    const ip = "203.0.113.20";
    for (let i = 0; i < READ_LIMIT; i += 1) {
      expect((await pub("get", `/${created.token}`, ip)).status).toBe(200);
    }
    expect((await pub("get", `/${created.token}`, ip)).status).toBe(429);
    expect((await pub("get", `/${created.token}`, "203.0.113.21")).status).toBe(200);
  });
});

describe("admin stick drift API", () => {
  it("requires the bearer token", async () => {
    expect((await request(app).get("/api/stick-drift/work-orders")).status).toBe(401);
    expect((await request(app).post("/api/stick-drift/work-orders/WFSD-1001/status").send({ status: "arrived" })).status).toBe(401);
  });

  it("keeps accounts apart", async () => {
    const { workOrderNumber } = await place();
    expect((await admin("get", "", otherToken)).body.workOrders).toEqual([]);
    expect((await admin("get", `/${workOrderNumber}`, otherToken)).status).toBe(404);
    expect((await admin("post", `/${workOrderNumber}/status`, otherToken).send({ status: "arrived" })).status).toBe(404);
    expect((await admin("post", `/${workOrderNumber}/notes`, otherToken).send({ text: "hi" })).status).toBe(404);
  });

  it("lists newest first with counts, filters by status and searches", async () => {
    const a = await place();
    const b = await place({ customer: { firstName: "Marcus", lastName: "O'Neil", phone: "713-555-0199" } });
    const c = await place({ customer: { firstName: "Ana", lastName: "Gamer", phone: "2815550100" } });
    await setStatus(b.workOrderNumber, "arrived");

    const all = await admin("get");
    expect(all.body.workOrders.map((w) => w.workOrderNumber)).toEqual([c.workOrderNumber, b.workOrderNumber, a.workOrderNumber]);
    expect(all.body.counts).toEqual({ label_created: 2, arrived: 1, repaired: 0, paid: 0, shipped_back: 0, delivered: 0, cancelled: 0 });

    const arrived = await admin("get", "?status=arrived");
    expect(arrived.body.workOrders.map((w) => w.workOrderNumber)).toEqual([b.workOrderNumber]);
    // Counts ignore the filter so the tabs keep their numbers.
    expect(arrived.body.counts.label_created).toBe(2);

    const find = async (q) => (await admin("get", `?q=${encodeURIComponent(q)}`)).body.workOrders.map((w) => w.workOrderNumber);
    expect(await find("wfsd-1002")).toEqual([b.workOrderNumber]);
    expect(await find("gamer")).toEqual([c.workOrderNumber, a.workOrderNumber]);
    expect(await find("ana gamer")).toEqual([c.workOrderNumber]);
    expect(await find("o'neil")).toEqual([b.workOrderNumber]);
    expect(await find("(713) 555-0199")).toEqual([b.workOrderNumber]);
    expect(await find("5550100")).toEqual([c.workOrderNumber]);
    expect(await find(".*")).toEqual([]);

    expect((await admin("get", "?status=bogus")).status).toBe(400);
  });

  it("walks the whole flow and records every change", async () => {
    const { workOrderNumber } = await place();
    expect((await setStatus(workOrderNumber, "arrived", { note: " Box OK " })).status).toBe(200);
    expect((await setStatus(workOrderNumber, "repaired")).status).toBe(200);
    expect((await setStatus(workOrderNumber, "paid", { note: "Zelle" })).status).toBe(200);

    const noTracking = await setStatus(workOrderNumber, "shipped_back");
    expect(noTracking.status).toBe(409);
    expect(noTracking.body.code).toBe("tracking_required");

    const shipped = await setStatus(workOrderNumber, "shipped_back", { returnTracking: { carrier: " USPS ", number: " 9400111 " } });
    expect(shipped.status).toBe(200);
    expect(shipped.body.returnTracking).toEqual({ carrier: "USPS", number: "9400111" });

    const done = await setStatus(workOrderNumber, "delivered");
    expect(done.body.status).toBe("delivered");
    expect(done.body.statusHistory.map((h) => [h.from, h.to, h.note])).toEqual([
      [null, "label_created", ""],
      ["label_created", "arrived", "Box OK"],
      ["arrived", "repaired", ""],
      ["repaired", "paid", "Zelle"],
      ["paid", "shipped_back", ""],
      ["shipped_back", "delivered", ""],
    ]);
    expect(done.body.statusHistory.every((h) => !Number.isNaN(Date.parse(h.at)))).toBe(true);
  });

  it("ships back with tracking saved earlier", async () => {
    const { workOrderNumber } = await place();
    for (const s of ["arrived", "repaired", "paid"]) await setStatus(workOrderNumber, s);
    const saved = await admin("put", `/${workOrderNumber}/return-tracking`).send({ carrier: "UPS", number: "1Z999AA10123456784" });
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe("paid");
    expect((await setStatus(workOrderNumber, "shipped_back")).status).toBe(200);
  });

  it("rejects invalid changes and leaves the work order untouched", async () => {
    const { workOrderNumber } = await place();
    for (const status of ["repaired", "paid", "shipped_back", "delivered", "label_created"]) {
      const res = await setStatus(workOrderNumber, status);
      expect(res.status).toBe(409);
    }
    expect((await setStatus(workOrderNumber, "refunded")).status).toBe(400);
    expect((await setStatus(workOrderNumber)).status).toBe(400);
    expect((await setStatus(workOrderNumber, "arrived", { returnTracking: { carrier: "USPS" } })).status).toBe(400);

    const after = (await admin("get", `/${workOrderNumber}`)).body;
    expect(after.status).toBe("label_created");
    expect(after.statusHistory).toHaveLength(1);
  });

  it("cancels only from label_created or arrived, and cancelled is final", async () => {
    const first = await place();
    expect((await setStatus(first.workOrderNumber, "cancelled", { note: "Changed their mind" })).status).toBe(200);
    expect((await setStatus(first.workOrderNumber, "arrived")).status).toBe(409);

    const second = await place();
    await setStatus(second.workOrderNumber, "arrived");
    expect((await setStatus(second.workOrderNumber, "cancelled")).status).toBe(200);

    const third = await place();
    await setStatus(third.workOrderNumber, "arrived");
    await setStatus(third.workOrderNumber, "repaired");
    expect((await setStatus(third.workOrderNumber, "cancelled")).status).toBe(409);
  });

  it("applies a double tap once", async () => {
    const { workOrderNumber } = await place();
    const results = await Promise.all([setStatus(workOrderNumber, "arrived"), setStatus(workOrderNumber, "arrived")]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await admin("get", `/${workOrderNumber}`)).body.statusHistory).toHaveLength(2);
  });

  it("adds notes without changing status", async () => {
    const { workOrderNumber } = await place();
    expect((await admin("post", `/${workOrderNumber}/notes`).send({ text: "  " })).status).toBe(400);
    expect((await admin("post", `/${workOrderNumber}/notes`).send({ text: "x".repeat(1001) })).status).toBe(400);
    await admin("post", `/${workOrderNumber}/notes`).send({ text: " Left stick only " });
    const res = await admin("post", `/${workOrderNumber}/notes`).send({ text: "Customer called" });
    expect(res.body.notes.map((n) => n.text)).toEqual(["Left stick only", "Customer called"]);
    expect(res.body.notes.every((n) => !Number.isNaN(Date.parse(n.at)))).toBe(true);
    expect(res.body.status).toBe("label_created");
    expect(res.body.statusHistory).toHaveLength(1);
  });

  it("validates return tracking and finds work orders case-insensitively", async () => {
    const { workOrderNumber } = await place();
    expect((await admin("put", `/${workOrderNumber}/return-tracking`).send({ carrier: "USPS", number: "" })).status).toBe(400);
    expect((await admin("get", `/${workOrderNumber.toLowerCase()}`)).status).toBe(200);
    expect((await admin("get", "/WFSD-9999")).status).toBe(404);
  });

  it("reports config readiness", async () => {
    const res = await request(app).get("/api/stick-drift/config").set("Authorization", `Bearer ${token}`);
    expect(res.body).toEqual({ priceCents: 4999, siteUrl: SITE, readiness: [] });
  });
});
