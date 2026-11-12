// Renaming or deleting a product, service or inventory part must never reach
// back into the jobs that used it: an old job keeps the name, price and cost it
// was saved with, and can still be edited and deleted afterwards.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";

let mongod;
let token;
let passwordHash;
let service;
let part;

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

const authed = (req) => req.set("Authorization", `Bearer ${token}`);
const api = {
  get: (path) => authed(request(app).get(`/api${path}`)),
  post: (path, body) => authed(request(app).post(`/api${path}`)).send(body),
  put: (path, body) => authed(request(app).put(`/api${path}`)).send(body),
  del: (path) => authed(request(app).delete(`/api${path}`))
};
const job = async (id) => (await api.get("/entries")).body.find((entry) => entry._id === id);
const stock = async () => (await api.get(`/inventory/${part._id}`)).body.quantity;

// What the job form sends on save: every line and every part, as they stand.
const asTheFormSends = (entry, extra = {}) => ({
  items: entry.items.map(({ productServiceOptionId, name, quantity, unitPrice }) => ({ productServiceOptionId, name, quantity, unitPrice })),
  inventoryUsage: entry.inventoryUsage.map(({ itemId, quantity }) => ({ itemId, quantity })),
  ...extra
});

async function newJob(phone = "555-0001") {
  const res = await api.post("/entries", {
    type: "Repair",
    date: "2026-10-01",
    customerPhone: phone,
    items: [{ productServiceOptionId: service._id, quantity: 1 }],
    inventoryUsage: [{ itemId: part._id, quantity: 1 }]
  });
  expect(res.status).toBe(201);
  return res.body;
}

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Entry.syncIndexes();
  await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  token = (await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" })).body.token;
  service = (await api.post("/reference-options", { kind: "product_service", name: "HDMI Gaming Consoles", optionType: "service", price: 140, cost: 0 })).body;
  part = (await api.post("/inventory", { name: "HDMI PS5", sku: "HDMI-1", quantity: 10, costPerUnit: 5, lowStockThreshold: 1 })).body;
});

describe("renaming", () => {
  it("renames a service without touching the jobs that used it", async () => {
    const created = await newJob();
    expect((await api.put(`/reference-options/${service._id}`, { name: "HDMI replacement" })).status).toBe(200);

    const old = await job(created._id);
    expect(old.items[0]).toMatchObject({ name: "HDMI Gaming Consoles", unitPrice: 140 });
    expect(String(old.items[0].productServiceOptionId)).toBe(service._id);

    const next = await newJob("555-0002");
    expect(next.items[0].name).toBe("HDMI replacement");
  });

  it("edits an inventory part: name, cost and the rest", async () => {
    const res = await api.put(`/inventory/${part._id}`, { name: "HDMI PS5 AliExpress 2", costPerUnit: 9, lowStockThreshold: 3 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: "HDMI PS5 AliExpress 2", costPerUnit: 9, lowStockThreshold: 3, sku: "HDMI-1" });

    expect((await api.put(`/inventory/${new mongoose.Types.ObjectId()}`, { name: "Nothing" })).status).toBe(404);
    expect((await api.put(`/inventory/${part._id}`, { name: " " })).status).toBe(400);
  });

  it("keeps an old job's part at the name and cost it was done at, even when the job is edited", async () => {
    const created = await newJob();
    await api.put(`/inventory/${part._id}`, { name: "HDMI PS5 AliExpress 2", costPerUnit: 9 });

    const edited = await api.put(`/entries/${created._id}`, asTheFormSends(await job(created._id), { notes: "edited" }));
    expect(edited.status).toBe(200);
    expect(edited.body.inventoryUsage[0]).toMatchObject({ name: "HDMI PS5", costPerUnit: 5, totalCost: 5 });
    expect(edited.body).toMatchObject({ expense: 5, netProfit: 135 });

    // A job done after the change costs what the part costs now.
    const next = await newJob("555-0002");
    expect(next.inventoryUsage[0]).toMatchObject({ name: "HDMI PS5 AliExpress 2", costPerUnit: 9 });
    expect(next.expense).toBe(9);
  });
});

describe("deleting a product or service", () => {
  it("leaves old jobs as they were, and still editable", async () => {
    const created = await newJob();
    expect((await api.del(`/reference-options/${service._id}`)).status).toBe(200);

    const old = await job(created._id);
    expect(old.items[0]).toMatchObject({ name: "HDMI Gaming Consoles", unitPrice: 140, optionType: "service", productServiceOptionId: null });
    expect(old.income).toBe(140);

    const edited = await api.put(`/entries/${created._id}`, asTheFormSends(old, { notes: "edited" }));
    expect(edited.status).toBe(200);
    expect(edited.body.items[0]).toMatchObject({ name: "HDMI Gaming Consoles", unitPrice: 140 });
    expect(edited.body.income).toBe(140);
  });

  it("accepts an edit that still carries the deleted product's id", async () => {
    const created = await newJob();
    // As left behind by deletes made before lines were unlinked.
    await mongoose.connection.collection("referenceoptions").deleteOne({ _id: new mongoose.Types.ObjectId(service._id) });

    const edited = await api.put(`/entries/${created._id}`, {
      items: [{ productServiceOptionId: service._id, quantity: 2 }]
    });
    expect(edited.status).toBe(200);
    expect(edited.body.items[0]).toMatchObject({ name: "HDMI Gaming Consoles", unitPrice: 140, quantity: 2, optionType: "service", productServiceOptionId: null });
    expect(edited.body.income).toBe(280);

    // An id that was never on the record is still refused.
    const bad = await api.put(`/entries/${created._id}`, { items: [{ productServiceOptionId: String(new mongoose.Types.ObjectId()), quantity: 1 }] });
    expect(bad.status).toBe(400);
  });
});

describe("deleting an inventory part", () => {
  it("leaves old jobs as they were, editable and deletable", async () => {
    const kept = await newJob();
    const removed = await newJob("555-0002");
    expect((await api.del(`/inventory/${part._id}`)).status).toBe(200);

    const old = await job(kept._id);
    expect(old.inventoryUsage[0]).toMatchObject({ name: "HDMI PS5", sku: "HDMI-1", quantity: 1, costPerUnit: 5 });
    expect(old.expense).toBe(5);

    const edited = await api.put(`/entries/${kept._id}`, asTheFormSends(old, { notes: "edited" }));
    expect(edited.status).toBe(200);
    expect(edited.body.inventoryUsage[0]).toMatchObject({ name: "HDMI PS5", costPerUnit: 5, totalCost: 5 });
    expect(edited.body.expense).toBe(5);

    // Taking the deleted part off the job, and deleting a job that used it.
    const cleared = await api.put(`/entries/${kept._id}`, { inventoryUsage: [] });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ inventoryUsage: [], expense: 0 });
    expect((await api.del(`/entries/${removed._id}`)).status).toBe(200);

    // More of a part that no longer exists cannot be used.
    const more = await api.put(`/entries/${kept._id}`, { inventoryUsage: [{ itemId: part._id, quantity: 1 }] });
    expect(more.status).toBe(400);
  });

  it("still moves stock for parts that exist", async () => {
    const created = await newJob();
    expect(await stock()).toBe(9);
    await api.put(`/entries/${created._id}`, { inventoryUsage: [{ itemId: part._id, quantity: 3 }] });
    expect(await stock()).toBe(7);
    expect((await api.del(`/entries/${created._id}`)).status).toBe(200);
    expect(await stock()).toBe(10);
  });
});
