// The dashboard's numbers, worked out on the server instead of on the phone.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { customerStats, productServiceStats, businessStats, topServiceIds } from "../insights/service.js";
import { businessToday } from "../insights/service.js";

let mongod;
let token;
let passwordHash;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  await mongoose.connect(mongod.getUri());
  passwordHash = await bcrypt.hash("password123", 10);
});
afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});
beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Promise.all([Entry.syncIndexes(), ReferenceOption.syncIndexes()]);
  await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  token = (await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" })).body.token;
});

const authed = (req) => req.set("Authorization", `Bearer ${token}`);
const get = (path) => authed(request(app).get(`/api${path}`));
const post = (path, body) => authed(request(app).post(`/api${path}`)).send(body);

describe("matching, as the phone did it", () => {
  const entry = (id, fields) => ({ _id: id, date: new Date("2026-10-01"), type: "Repair", income: 10, expense: 0, ...fields });

  it("ties records to customers by link, email, phone in any format, Instagram, and name only when nothing else", () => {
    const customers = [
      { _id: "c1", name: "Maria", phone: "(832) 542-4045", email: "maria@example.com", instagram: "@maria" },
      { _id: "c2", name: "Dan", phone: "", email: "", instagram: "" },
      { _id: "c3", name: "", phone: "", email: "", instagram: "" }
    ];
    const entries = [
      entry("e1", { customerOptionId: "c1", income: 100 }),
      entry("e2", { customerPhone: "1-832-542-4045", income: 50, date: new Date("2026-11-02") }),
      entry("e3", { customerEmail: " MARIA@example.com ", customerPhone: "8325424045" }),
      entry("e4", { customerInstagram: "Maria" }),
      entry("e5", { customerName: "dan" }),
      // Has a phone, so its name alone does not make it Dan's.
      entry("e6", { customerName: "Dan", customerPhone: "555-0000" })
    ];
    const stats = customerStats(entries, customers);
    expect(stats.c1).toEqual({ revenue: 170, count: 4, lastDate: new Date("2026-11-02").toISOString() });
    expect(stats.c2).toMatchObject({ count: 1, revenue: 10 });
    expect(stats.c3).toEqual({ revenue: 0, count: 0, lastDate: "" });
  });

  it("totals each catalog item by line, sharing a job's cost across its lines", () => {
    const items = [
      { _id: "p1", name: "HDMI port", optionType: "service" },
      { _id: "p2", name: "Deep clean", optionType: "" }
    ];
    const entries = [
      entry("e1", { income: 200, expense: 20, items: [
        { productServiceOptionId: "p1", name: "HDMI port", optionType: "service", quantity: 1, unitPrice: 150 },
        { productServiceOptionId: null, name: "deep clean", optionType: "service", quantity: 1, unitPrice: 50 }
      ] }),
      entry("e2", { income: 140, expense: 10, productServiceName: "HDMI Port", productServiceType: "" })
    ];
    const stats = productServiceStats(entries, items);
    expect(stats.p1).toMatchObject({ revenue: 290, count: 2, cost: 25, profit: 265 });
    expect(stats.p2).toMatchObject({ revenue: 50, count: 1, cost: 5, profit: 45 });
    expect(topServiceIds(entries)).toEqual(["p1"]);
  });

  it("adds up what each business owes and what is overdue", () => {
    const entries = [
      entry("e1", { isB2B: true, businessOptionId: "b1", income: 100, salesTax: 8, dueDate: new Date("2026-10-10"), status: "Pending", payments: [{ amount: 50 }] }),
      entry("e2", { isB2B: true, businessOptionId: "b1", income: 40, salesTax: 0, dueDate: new Date("2026-12-10"), status: "Pending" }),
      entry("e3", { isB2B: true, businessOptionId: "b1", type: "Refund", income: 0, expense: 30 }),
      entry("e4", { isB2B: true, businessOptionId: "b2", income: 70, status: "Paid", dueDate: new Date("2026-10-01") })
    ];
    const { stats, overdueCount } = businessStats(entries, "2026-11-12");
    expect(stats.b1).toMatchObject({ count: 3, sales: 110, unpaid: 98, overdue: 58, overdueCount: 1 });
    expect(stats.b2).toMatchObject({ count: 1, unpaid: 0, overdueCount: 0 });
    expect(overdueCount).toBe(1);
  });
});

describe("routes", () => {
  it("sends daily totals and stats, never the records", async () => {
    const customer = (await post("/reference-options", { kind: "customer", name: "Maria", phone: "555-0101" })).body;
    await post("/entries", { type: "Repair", date: "2026-10-01", description: "HDMI", income: 100, customerPhone: "555-0101" });
    await post("/entries", { type: "Expenses", date: "2026-10-01", description: "Gas", expense: 20, category: "Gas" });
    await post("/entries", { type: "Owner Draw", date: "2026-10-02", description: "Draw", expense: 300 });

    const res = await get("/entries/insights");
    expect(res.status).toBe(200);
    expect(res.body.daily).toEqual([
      { date: "2026-10-01", income: 100, expense: 20, ownerDraws: 0, salesTax: 8.25, net: 80 },
      { date: "2026-10-02", income: 0, expense: 0, ownerDraws: 300, salesTax: 0, net: 0 }
    ]);
    expect(res.body.customerStats[customer._id]).toMatchObject({ revenue: 100, count: 1 });
    expect(res.body).not.toHaveProperty("entries");
  });

  it("shows today's jobs in time order with what is ready and owed", async () => {
    const day = businessToday();
    await post("/entries", { type: "Repair", date: day, description: "Late", income: 100, customerPhone: "555-0101", scheduledTime: "15:00", jobStatus: "Booked" });
    await post("/entries", { type: "Repair", date: day, description: "Early", income: 50, customerPhone: "555-0102", scheduledTime: "09:00", jobStatus: "Booked" });
    await post("/entries", { type: "Repair", date: "2026-01-05", description: "Old", income: 80, customerPhone: "555-0103", jobStatus: "Ready" });
    await post("/entries", { type: "Repair", date: "2026-01-06", description: "Paid", income: 80, customerPhone: "555-0104", status: "Paid", paymentMethod: "Cash", jobStatus: "Done" });

    const res = await get("/entries/today");
    expect(res.status).toBe(200);
    expect(res.body.date).toBe(day);
    expect(res.body.jobs.map((job) => job.description)).toEqual(["Early", "Late"]);
    expect(res.body).toMatchObject({ todayCount: 2, readyCount: 1, owedCount: 3 });
    expect(res.body.owedTotal).toBe(Math.round((100 + 50 + 80) * 1.0825 * 100) / 100);
  });

  it("finds a customer's, an item's and a business's records, and one record by id", async () => {
    const customer = (await post("/reference-options", { kind: "customer", name: "Maria", phone: "555-0101" })).body;
    const item = (await post("/reference-options", { kind: "product_service", name: "HDMI port", optionType: "service", price: 140, cost: 0 })).body;
    const business = (await post("/reference-options", { kind: "business", name: "Game Shop" })).body;
    const mine = (await post("/entries", { type: "Repair", date: "2026-10-01", customerPhone: "(555) 0101", items: [{ productServiceOptionId: item._id }] })).body;
    await post("/entries", { type: "Repair", date: "2026-10-02", description: "Other", income: 10, customerPhone: "555-0199" });
    const store = (await post("/entries", { type: "Sales", date: "2026-10-03", description: "Bulk", income: 300, isB2B: true, businessOptionId: business._id })).body;

    expect((await get(`/entries/related?customerId=${customer._id}`)).body.map((e) => e._id)).toEqual([mine._id]);
    expect((await get(`/entries/related?productServiceId=${item._id}`)).body.map((e) => e._id)).toEqual([mine._id]);
    expect((await get(`/entries/related?businessId=${business._id}`)).body.map((e) => e._id)).toEqual([store._id]);
    expect((await get("/entries/related")).status).toBe(400);
    expect((await get(`/entries/related?customerId=${new mongoose.Types.ObjectId()}`)).status).toBe(404);

    const one = await get(`/entries/${mine._id}`);
    expect(one.status).toBe(200);
    expect(one.body).toMatchObject({ _id: mine._id, income: 140 });
    expect((await get(`/entries/${new mongoose.Types.ObjectId()}`)).status).toBe(404);
    // The fixed paths still answer as themselves.
    expect((await get("/entries/summary?from=2026-10-01&to=2026-10-31")).status).toBe(200);
  });

  it("sends only placed records, with only what the Areas screen needs", async () => {
    await Entry.create([
      { accountId: (await Settings.findOne({ key: "main" }))._id, date: new Date("2026-10-01"), type: "Repair", income: 100, netProfit: 100, addressZip: "77072", addressLat: 29.7, addressLng: -95.5, notes: "secret" },
      { accountId: (await Settings.findOne({ key: "main" }))._id, date: new Date("2026-10-02"), type: "Repair", income: 50, netProfit: 50 }
    ]);
    const res = await get("/entries/area-points");
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ addressZip: "77072", addressLat: 29.7, income: 100 });
    expect(res.body[0]).not.toHaveProperty("notes");
  });

  it("keeps each account's numbers to itself", async () => {
    const other = await Settings.create({ key: "other", email: "other@example.com", emailVerified: true, passwordHash });
    await Entry.create({ accountId: other._id, date: new Date("2026-10-01"), type: "Repair", income: 999, netProfit: 999, addressZip: "77001" });
    const [insights, area] = await Promise.all([get("/entries/insights"), get("/entries/area-points")]);
    expect(insights.body.daily).toEqual([]);
    expect(area.body).toEqual([]);
  });
});
