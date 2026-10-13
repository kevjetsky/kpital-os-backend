import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { ReferenceOption } from "../models/ReferenceOption.js";

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
  // dropDatabase takes the unique name index with it.
  await ReferenceOption.syncIndexes();
  await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  const login = await request(app)
    .post("/api/auth/login")
    .send({ email: "owner@example.com", password: "password123" });
  token = login.body.token;
});

const authed = (req) => req.set("Authorization", `Bearer ${token}`);

async function createBusiness(overrides = {}) {
  const res = await authed(request(app).post("/api/reference-options")).send({
    kind: "business",
    name: "GameStop #4821",
    contactName: "Dana",
    phone: "713-555-0100",
    email: "store4821@example.com",
    addressLine1: "100 Main St",
    city: "Houston",
    state: "TX",
    postalCode: "77002",
    taxExempt: true,
    taxExemptId: "32012345678",
    ...overrides
  });
  expect(res.status).toBe(201);
  return res.body;
}

const postEntry = (body) => authed(request(app).post("/api/entries")).send(body);
const putEntry = (id, body) => authed(request(app).put(`/api/entries/${id}`)).send(body);

function b2bRepair(business, overrides = {}) {
  return {
    type: "Repair",
    date: "2026-10-01",
    description: "DualSense stick replacement",
    income: 100,
    isB2B: true,
    businessOptionId: business._id,
    ...overrides
  };
}

describe("business accounts", () => {
  it("creates, lists, updates and deletes a business", async () => {
    const business = await createBusiness();
    expect(business).toMatchObject({
      name: "GameStop #4821",
      contactName: "Dana",
      phone: "713-555-0100",
      address: "100 Main St, Houston, TX 77002",
      taxExempt: true,
      taxExemptId: "32012345678"
    });

    const list = await authed(request(app).get("/api/reference-options"));
    expect(list.body.businesses.map((b) => b.name)).toEqual(["GameStop #4821"]);
    expect(list.body.customers).toEqual([]);

    // A partial update leaves everything it does not mention alone.
    const updated = await authed(request(app).put(`/api/reference-options/${business._id}`)).send({ taxExempt: false });
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({ name: "GameStop #4821", phone: "713-555-0100", taxExempt: false, taxExemptId: "32012345678" });

    const removed = await authed(request(app).delete(`/api/reference-options/${business._id}`));
    expect(removed.status).toBe(200);
    expect((await authed(request(app).get("/api/reference-options"))).body.businesses).toEqual([]);
  });

  it("needs a name and refuses a duplicate one", async () => {
    const nameless = await authed(request(app).post("/api/reference-options")).send({ kind: "business", name: " " });
    expect(nameless.status).toBe(400);

    await createBusiness();
    const duplicate = await authed(request(app).post("/api/reference-options")).send({ kind: "business", name: "gamestop #4821" });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.message).toBe("A business with this name already exists.");
  });

  it("does not need a phone, and may share a name with a customer", async () => {
    await authed(request(app).post("/api/reference-options")).send({ kind: "customer", name: "Pixel Pawn", phone: "555-0199" });
    const res = await authed(request(app).post("/api/reference-options")).send({ kind: "business", name: "Pixel Pawn" });
    expect(res.status).toBe(201);
    expect(res.body.taxExempt).toBe(false);
  });
});

describe("B2B records", () => {
  it("charges no sales tax on a tax-exempt B2B record and bills the business", async () => {
    const business = await createBusiness();
    const res = await postEntry(b2bRepair(business, { taxExempt: true }));

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      isB2B: true,
      businessOptionId: business._id,
      businessName: "GameStop #4821",
      taxExempt: true,
      income: 100,
      salesTax: 0,
      netProfit: 100,
      customerName: "GameStop #4821",
      customerPhone: "713-555-0100",
      customerEmail: "store4821@example.com",
      customerAddress: "100 Main St, Houston, TX 77002",
      customerOptionId: null
    });
    // The store is not turned into a walk-in customer profile.
    expect(await ReferenceOption.countDocuments({ kind: "customer" }).setOptions({ allowCrossAccount: true })).toBe(0);
  });

  it("takes the business's tax default unless the record says otherwise", async () => {
    const exempt = await createBusiness();
    const taxed = await createBusiness({ name: "Corner Pawn", taxExempt: false });

    expect((await postEntry(b2bRepair(exempt))).body).toMatchObject({ taxExempt: true, salesTax: 0 });
    expect((await postEntry(b2bRepair(taxed))).body).toMatchObject({ taxExempt: false, salesTax: 8.25 });
    expect((await postEntry(b2bRepair(exempt, { taxExempt: false }))).body).toMatchObject({ taxExempt: false, salesTax: 8.25 });
    expect((await postEntry(b2bRepair(taxed, { taxExempt: true }))).body).toMatchObject({ taxExempt: true, salesTax: 0 });
  });

  it("needs a real business, and waives the customer contact requirement", async () => {
    const business = await createBusiness({ phone: "", email: "" });

    const missing = await postEntry(b2bRepair(business, { businessOptionId: undefined }));
    expect(missing.status).toBe(400);
    expect(missing.body.message).toBe("Choose the business this B2B record is for.");

    const unknown = await postEntry(b2bRepair(business, { businessOptionId: String(new mongoose.Types.ObjectId()) }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.message).toBe("Business not found.");

    expect((await postEntry(b2bRepair(business, { businessOptionId: "nope" }))).status).toBe(400);

    // A customer is not a business.
    const customer = await authed(request(app).post("/api/reference-options")).send({ kind: "customer", name: "Sam", phone: "555-0101" });
    expect((await postEntry(b2bRepair(business, { businessOptionId: customer.body._id }))).status).toBe(400);

    // No phone or Instagram anywhere, which a walk-in repair would be refused for.
    const ok = await postEntry(b2bRepair(business));
    expect(ok.status).toBe(201);
    expect(ok.body.customerPhone).toBe("");
  });

  it("ignores tax exempt without B2B, and B2B on a type that has no buyer", async () => {
    const business = await createBusiness();

    const walkIn = await postEntry({
      type: "Repair",
      date: "2026-10-01",
      description: "HDMI port",
      income: 100,
      customerPhone: "555-0101",
      taxExempt: true
    });
    expect(walkIn.body).toMatchObject({ isB2B: false, taxExempt: false, salesTax: 8.25, businessName: "" });

    const expense = await postEntry({
      type: "Expenses",
      date: "2026-10-01",
      description: "Solder",
      expense: 20,
      isB2B: true,
      businessOptionId: business._id,
      taxExempt: true
    });
    expect(expense.status).toBe(201);
    expect(expense.body).toMatchObject({ isB2B: false, businessOptionId: null, taxExempt: false });
  });

  it("keeps the warranty text off by default, and on when asked", async () => {
    const business = await createBusiness();
    expect((await postEntry(b2bRepair(business))).body.suppressSms).toBe(true);
    expect((await postEntry(b2bRepair(business, { suppressSms: false }))).body.suppressSms).toBe(false);
  });

  it("reverses no tax when a tax-exempt B2B sale is refunded", async () => {
    const business = await createBusiness();
    const sale = (await postEntry(b2bRepair(business))).body;

    const linked = await postEntry({
      type: "Refund",
      date: "2026-10-03",
      description: "Refund",
      expense: 100,
      refundOf: sale._id,
      isB2B: true,
      businessOptionId: business._id
    });
    expect(linked.status).toBe(201);
    expect(linked.body).toMatchObject({ isB2B: true, taxExempt: true, salesTax: 0, netProfit: -100 });

    const unlinked = await postEntry({
      type: "Refund",
      date: "2026-10-03",
      description: "Refund",
      expense: 40,
      isB2B: true,
      businessOptionId: business._id,
      taxExempt: true
    });
    expect(unlinked.body.salesTax).toBe(0);
  });

  it("moves a record into and out of B2B on update", async () => {
    const business = await createBusiness();
    const walkIn = (await postEntry({
      type: "Repair",
      date: "2026-10-01",
      description: "HDMI port",
      income: 100,
      customerPhone: "555-0101"
    })).body;
    expect(walkIn.customerOptionId).toBeTruthy();

    const toB2B = await putEntry(walkIn._id, { isB2B: true, businessOptionId: business._id });
    expect(toB2B.status).toBe(200);
    expect(toB2B.body).toMatchObject({
      isB2B: true,
      businessName: "GameStop #4821",
      taxExempt: true,
      salesTax: 0,
      customerName: "GameStop #4821",
      customerPhone: "713-555-0100",
      customerOptionId: null
    });

    // An edit that does not mention B2B leaves it, and its tax treatment, alone.
    const statusOnly = await putEntry(walkIn._id, { status: "Completed" });
    expect(statusOnly.body).toMatchObject({ isB2B: true, taxExempt: true, salesTax: 0, businessOptionId: business._id });

    const taxedAgain = await putEntry(walkIn._id, { taxExempt: false });
    expect(taxedAgain.body).toMatchObject({ isB2B: true, taxExempt: false, salesTax: 8.25 });

    // Leaving B2B does not carry the store over as a walk-in customer.
    const back = await putEntry(walkIn._id, { isB2B: false, customerPhone: "555-0101" });
    expect(back.status).toBe(200);
    expect(back.body).toMatchObject({
      isB2B: false,
      businessOptionId: null,
      businessName: "",
      taxExempt: false,
      salesTax: 8.25,
      customerPhone: "555-0101",
      customerEmail: ""
    });
    expect(back.body.customerOptionId).toBe(walkIn.customerOptionId);
    expect(await ReferenceOption.countDocuments({ kind: "customer" }).setOptions({ allowCrossAccount: true })).toBe(1);
  });

  it("keeps a record's name and tax treatment after its business is deleted", async () => {
    const business = await createBusiness();
    const entry = (await postEntry(b2bRepair(business))).body;

    await authed(request(app).delete(`/api/reference-options/${business._id}`));

    const list = await authed(request(app).get("/api/entries"));
    expect(list.body[0]).toMatchObject({ isB2B: true, businessOptionId: null, businessName: "GameStop #4821", taxExempt: true });

    // Still editable, including by a form that sends the now-empty link back.
    const edited = await putEntry(entry._id, { income: 150, isB2B: true, businessOptionId: null, taxExempt: true });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ isB2B: true, businessName: "GameStop #4821", income: 150, salesTax: 0, customerName: "GameStop #4821" });
  });

  it("filters the record list by B2B and by business, and finds records by business name", async () => {
    const gamestop = await createBusiness();
    const pawn = await createBusiness({ name: "Corner Pawn", phone: "", taxExempt: false });
    await postEntry(b2bRepair(gamestop));
    await postEntry(b2bRepair(pawn));
    await postEntry({ type: "Repair", date: "2026-10-01", description: "HDMI port", income: 100, customerPhone: "555-0101" });

    const names = (res) => res.body.map((e) => e.businessName).sort();
    expect(names(await authed(request(app).get("/api/entries?b2b=true")))).toEqual(["Corner Pawn", "GameStop #4821"]);
    expect(names(await authed(request(app).get("/api/entries?b2b=false")))).toEqual([""]);
    expect(names(await authed(request(app).get(`/api/entries?businessOptionId=${pawn._id}`)))).toEqual(["Corner Pawn"]);
    expect(names(await authed(request(app).get("/api/entries?search=corner")))).toEqual(["Corner Pawn"]);
    expect((await authed(request(app).get("/api/entries?businessOptionId=nope"))).status).toBe(400);
  });

  it("offers a business's own records as warranty and refund candidates", async () => {
    const gamestop = await createBusiness();
    const pawn = await createBusiness({ name: "Corner Pawn", phone: "", taxExempt: false });
    const job = (await postEntry(b2bRepair(gamestop))).body;
    await postEntry(b2bRepair(pawn));

    const warranty = await authed(
      request(app).get(`/api/entries/warranty-candidates?businessOptionId=${gamestop._id}&date=2026-10-10`)
    );
    expect(warranty.status).toBe(200);
    expect(warranty.body.candidates.map((c) => c._id)).toEqual([job._id]);

    const refund = await authed(request(app).get(`/api/entries/refund-candidates?businessOptionId=${gamestop._id}`));
    expect(refund.body.candidates.map((c) => c._id)).toEqual([job._id]);
  });

  it("keeps exempt sales out of the tax owed", async () => {
    const business = await createBusiness();
    await postEntry(b2bRepair(business, { status: "Paid", paymentMethod: "Zelle" }));
    await postEntry({
      type: "Repair",
      date: "2026-10-02",
      description: "HDMI port",
      income: 200,
      customerPhone: "555-0101",
      status: "Paid",
      paymentMethod: "Cash"
    });

    const liability = await authed(request(app).get("/api/tax/liability?year=2026"));
    expect(liability.body.quarters[3].collected).toBe(16.5);

    const summary = await authed(request(app).get("/api/entries/summary?from=2026-10-01&to=2026-10-31"));
    expect(summary.body.range).toMatchObject({ income: 300, salesTax: 16.5, net: 300 });
  });
});
