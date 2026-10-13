import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { Entry } from "../models/Entry.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { runNotifications } from "../services/notificationRunner.js";

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

const isoDay = (date) => new Date(date).toISOString().slice(0, 10);
const daysFromToday = (days) => isoDay(Date.now() + days * 24 * 60 * 60 * 1000);

describe("payment terms", () => {
  it("gives a B2B record the business's terms and a due date, and none without terms", async () => {
    const net15 = await createBusiness({ paymentTermsDays: 15 });
    const noTerms = await createBusiness({ name: "Corner Pawn", paymentTermsDays: 0 });
    expect(net15.paymentTermsDays).toBe(15);

    const onTerms = (await postEntry(b2bRepair(net15))).body;
    expect(onTerms.paymentTermsDays).toBe(15);
    expect(isoDay(onTerms.dueDate)).toBe("2026-10-16");

    expect((await postEntry(b2bRepair(noTerms))).body).toMatchObject({ paymentTermsDays: 0, dueDate: null });

    // The record can set its own terms, and a walk-in record never has any.
    const custom = (await postEntry(b2bRepair(net15, { paymentTermsDays: 30 }))).body;
    expect(isoDay(custom.dueDate)).toBe("2026-10-31");
    const walkIn = await postEntry({
      type: "Repair",
      date: "2026-10-01",
      description: "HDMI port",
      income: 100,
      customerPhone: "555-0101",
      paymentTermsDays: 30
    });
    expect(walkIn.body).toMatchObject({ paymentTermsDays: 0, dueDate: null });

    expect((await postEntry(b2bRepair(net15, { paymentTermsDays: 1.5 }))).status).toBe(400);
    expect((await postEntry(b2bRepair(net15, { paymentTermsDays: 999 }))).status).toBe(400);
    const badBusiness = await authed(request(app).post("/api/reference-options")).send({ kind: "business", name: "Bad Terms", paymentTermsDays: -1 });
    expect(badBusiness.status).toBe(400);
  });

  it("keeps a record's terms when the business changes its own, and moves the due date with the record date", async () => {
    const business = await createBusiness({ paymentTermsDays: 15 });
    const entry = (await postEntry(b2bRepair(business))).body;

    await authed(request(app).put(`/api/reference-options/${business._id}`)).send({ paymentTermsDays: 60 });

    const moved = await putEntry(entry._id, { date: "2026-10-10" });
    expect(moved.body.paymentTermsDays).toBe(15);
    expect(isoDay(moved.body.dueDate)).toBe("2026-10-25");

    // Moving the record to another business takes that business's terms.
    const other = await createBusiness({ name: "Corner Pawn", paymentTermsDays: 7, taxExempt: false });
    const switched = await putEntry(entry._id, { businessOptionId: other._id });
    expect(switched.body).toMatchObject({ paymentTermsDays: 7, taxExempt: false, salesTax: 8.25 });
    expect(isoDay(switched.body.dueDate)).toBe("2026-10-17");

    const cleared = await putEntry(entry._id, { paymentTermsDays: 0 });
    expect(cleared.body.dueDate).toBeNull();
  });

  it("lists what is overdue: past due and still unpaid", async () => {
    const business = await createBusiness({ paymentTermsDays: 15 });
    const late = (await postEntry(b2bRepair(business, { date: daysFromToday(-40), description: "Late" }))).body;
    await postEntry(b2bRepair(business, { date: daysFromToday(-40), description: "Settled", status: "Paid", paymentMethod: "Zelle" }));
    await postEntry(b2bRepair(business, { date: daysFromToday(-2), description: "Not due yet" }));

    const overdue = await authed(request(app).get("/api/entries?overdue=true"));
    expect(overdue.body.map((e) => e.description)).toEqual(["Late"]);
    expect((await authed(request(app).get("/api/entries?overdue=true&type=Sales"))).body).toEqual([]);

    await putEntry(late._id, { status: "Paid", paymentMethod: "Cash" });
    expect((await authed(request(app).get("/api/entries?overdue=true"))).body).toEqual([]);
  });
});

describe("certificate expiry", () => {
  it("stops defaulting to tax exempt once the certificate has lapsed on the record's date", async () => {
    const business = await createBusiness({ taxExemptExpiresAt: "2026-10-15" });
    expect(isoDay(business.taxExemptExpiresAt)).toBe("2026-10-15");

    expect((await postEntry(b2bRepair(business, { date: "2026-10-15" }))).body).toMatchObject({ taxExempt: true, salesTax: 0 });
    expect((await postEntry(b2bRepair(business, { date: "2026-10-16" }))).body).toMatchObject({ taxExempt: false, salesTax: 8.25 });
    // Ticking it by hand is still the owner's call.
    expect((await postEntry(b2bRepair(business, { date: "2026-10-16", taxExempt: true }))).body.salesTax).toBe(0);

    const cleared = await authed(request(app).put(`/api/reference-options/${business._id}`)).send({ taxExemptExpiresAt: "" });
    expect(cleared.body.taxExemptExpiresAt).toBeNull();
    expect((await postEntry(b2bRepair(business, { date: "2027-01-01" }))).body.taxExempt).toBe(true);

    const bad = await authed(request(app).put(`/api/reference-options/${business._id}`)).send({ taxExemptExpiresAt: "soon" });
    expect(bad.status).toBe(400);
  });
});

describe("B2B pricing", () => {
  it("stores a wholesale price on a product and snapshots it on B2B records only", async () => {
    const business = await createBusiness();
    const product = await authed(request(app).post("/api/reference-options")).send({
      kind: "product_service",
      name: "Stick replacement",
      optionType: "service",
      price: 60,
      cost: 8,
      b2bPrice: 40
    });
    expect(product.status).toBe(201);
    expect(product.body.b2bPrice).toBe(40);

    const b2b = await postEntry(b2bRepair(business, { productServiceOptionId: product.body._id, income: 40 }));
    expect(b2b.body.productServicePrice).toBe(40);

    const walkIn = await postEntry({
      type: "Repair",
      date: "2026-10-01",
      income: 60,
      customerPhone: "555-0101",
      productServiceOptionId: product.body._id
    });
    expect(walkIn.body.productServicePrice).toBe(60);

    // Clearing it puts B2B records back on the normal price.
    const cleared = await authed(request(app).put(`/api/reference-options/${product.body._id}`)).send({ b2bPrice: null });
    expect(cleared.body).toMatchObject({ b2bPrice: null, price: 60 });
    const after = await postEntry(b2bRepair(business, { productServiceOptionId: product.body._id }));
    expect(after.body.productServicePrice).toBe(60);

    const plain = await authed(request(app).post("/api/reference-options")).send({
      kind: "product_service", name: "HDMI port", optionType: "service", price: 120
    });
    expect(plain.body.b2bPrice).toBeNull();
    const bad = await authed(request(app).put(`/api/reference-options/${product.body._id}`)).send({ b2bPrice: -5 });
    expect(bad.status).toBe(400);
  });
});

describe("business statement", () => {
  it("lists a business's records with what was billed, paid and is still owed", async () => {
    const business = await createBusiness({ taxExempt: false, paymentTermsDays: 15 });
    const other = await createBusiness({ name: "Corner Pawn" });

    const late = (await postEntry(b2bRepair(business, { date: daysFromToday(-40), description: "Late job", income: 100 }))).body;
    await authed(request(app).post(`/api/entries/${late._id}/payments`)).send({ amount: 50, date: daysFromToday(-30), method: "Zelle" });
    await postEntry(b2bRepair(business, { date: daysFromToday(-3), description: "Paid job", income: 200, status: "Paid", paymentMethod: "Cash" }));
    await postEntry(b2bRepair(business, { date: daysFromToday(-1), description: "Exempt job", income: 40, taxExempt: true }));
    await postEntry({ type: "Refund", date: daysFromToday(-1), description: "Refund", expense: 20, isB2B: true, businessOptionId: business._id });
    await postEntry(b2bRepair(other, { description: "Someone else's" }));

    const all = await authed(request(app).get(`/api/entries/business-statement?businessOptionId=${business._id}`));
    expect(all.status).toBe(200);
    expect(all.body.business.name).toBe("GameStop #4821");
    expect(all.body.lines.map((line) => line.description)).toEqual(["Late job", "Paid job", "Exempt job", "Refund"]);
    expect(all.body.lines[0]).toMatchObject({ subtotal: 100, salesTax: 8.25, total: 108.25, paid: 50, balance: 58.25, overdue: true });
    expect(all.body.lines[1]).toMatchObject({ total: 216.5, paid: 216.5, balance: 0, overdue: false });
    expect(all.body.lines[2]).toMatchObject({ taxExempt: true, salesTax: 0, total: 40, balance: 40, overdue: false });
    expect(all.body.lines[3]).toMatchObject({ subtotal: -20, salesTax: -1.65, total: -21.65, balance: 0 });
    expect(all.body.totals).toMatchObject({ count: 4, subtotal: 320, total: 343.1, paid: 266.5, balance: 98.25, overdue: 58.25 });

    const unpaid = await authed(
      request(app).get(`/api/entries/business-statement?businessOptionId=${business._id}&unpaidOnly=true`)
    );
    expect(unpaid.body.lines.map((line) => line.description)).toEqual(["Late job", "Exempt job"]);
    expect(unpaid.body.totals.balance).toBe(98.25);

    const recent = await authed(
      request(app).get(
        `/api/entries/business-statement?businessOptionId=${business._id}&from=${daysFromToday(-3)}&to=${daysFromToday(-3)}`
      )
    );
    expect(recent.body.lines.map((line) => line.description)).toEqual(["Paid job"]);

    expect((await authed(request(app).get("/api/entries/business-statement"))).status).toBe(400);
    expect(
      (await authed(request(app).get(`/api/entries/business-statement?businessOptionId=${new mongoose.Types.ObjectId()}`))).status
    ).toBe(404);
    expect(
      (await authed(request(app).get(`/api/entries/business-statement?businessOptionId=${business._id}&from=nope`))).status
    ).toBe(400);
  });
});

describe("parts on a record", () => {
  async function createPart(overrides = {}) {
    const res = await authed(request(app).post("/api/inventory")).send({
      name: "DualSense stick module",
      sku: "DS-STICK",
      category: "Sticks",
      quantity: 10,
      costPerUnit: 4,
      ...overrides
    });
    expect(res.status).toBe(201);
    return res.body;
  }
  const stock = async (id) => (await authed(request(app).get(`/api/inventory/${id}`))).body.quantity;

  it("adds parts to a record without resending the ones already on it", async () => {
    const sticks = await createPart();
    const ports = await createPart({ name: "HDMI port", sku: "HDMI-1", category: "HDMI Ports", costPerUnit: 6 });

    const entry = (await postEntry({
      type: "Repair",
      date: "2026-10-01",
      description: "Stick repair",
      income: 100,
      expense: 5,
      customerPhone: "555-0101",
      inventoryUsage: [{ itemId: sticks._id, quantity: 1 }]
    })).body;
    expect(entry).toMatchObject({ inventoryCost: 4, expense: 9, netProfit: 91 });
    expect(await stock(sticks._id)).toBe(9);

    const added = await putEntry(entry._id, {
      addInventoryUsage: [{ itemId: sticks._id, quantity: 1 }, { itemId: ports._id, quantity: 2 }]
    });
    expect(added.status).toBe(200);
    const usage = Object.fromEntries(added.body.inventoryUsage.map((u) => [u.sku, u.quantity]));
    expect(usage).toEqual({ "DS-STICK": 2, "HDMI-1": 2 });
    // 2 sticks at $4 and 2 ports at $6, on top of the $5 typed by hand.
    expect(added.body).toMatchObject({ inventoryCost: 20, expense: 25, netProfit: 75 });
    expect(await stock(sticks._id)).toBe(8);
    expect(await stock(ports._id)).toBe(8);

    // Sending the full list still replaces it, and puts the rest back in stock.
    const replaced = await putEntry(entry._id, { inventoryUsage: [{ itemId: ports._id, quantity: 1 }] });
    expect(replaced.body).toMatchObject({ inventoryCost: 6, expense: 11 });
    expect(await stock(sticks._id)).toBe(10);
    expect(await stock(ports._id)).toBe(9);
  });

  it("refuses parts that are not in stock or do not exist, and changes nothing", async () => {
    const sticks = await createPart({ quantity: 1 });
    const entry = (await postEntry({
      type: "Repair", date: "2026-10-01", description: "Stick repair", income: 100, customerPhone: "555-0101"
    })).body;

    const tooMany = await putEntry(entry._id, { addInventoryUsage: [{ itemId: sticks._id, quantity: 2 }] });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toMatch(/not enough stock/i);
    expect((await putEntry(entry._id, { addInventoryUsage: [{ itemId: String(new mongoose.Types.ObjectId()), quantity: 1 }] })).status).toBe(400);
    expect((await putEntry(entry._id, { addInventoryUsage: "sticks" })).status).toBe(400);
    expect(await stock(sticks._id)).toBe(1);
  });

  it("finds parts by name, SKU or category", async () => {
    await createPart();
    await createPart({ name: "HDMI port", sku: "HDMI-1", category: "HDMI Ports" });

    const names = async (search) =>
      (await authed(request(app).get(`/api/inventory?search=${encodeURIComponent(search)}`))).body.map((item) => item.sku);
    expect(await names("stick")).toEqual(["DS-STICK"]);
    expect(await names("hdmi-1")).toEqual(["HDMI-1"]);
    expect(await names("ports")).toEqual(["HDMI-1"]);
    expect(await names("(")).toEqual([]);
    expect((await authed(request(app).get("/api/inventory"))).body).toHaveLength(2);
  });
});

describe("B2B reminders", () => {
  async function subscribe() {
    const account = await Settings.findOne({ email: "owner@example.com" });
    await PushSubscription.create({
      accountId: account._id,
      endpoint: "https://push.example/device-1",
      keys: { p256dh: "key", auth: "auth" }
    });
    return String(account._id);
  }

  it("warns once before a certificate lapses, once after, and again for a renewed date", async () => {
    const accountId = await subscribe();
    const soon = await createBusiness({ taxExemptExpiresAt: daysFromToday(10) });
    await createBusiness({ name: "Far Off", taxExemptExpiresAt: daysFromToday(200) });
    await createBusiness({ name: "No Date" });
    await createBusiness({ name: "Not Exempt", taxExempt: false, taxExemptExpiresAt: daysFromToday(5) });

    const first = await runNotifications(new Date());
    expect(first.accounts[accountId].certExpiry).toMatchObject({ alerted: 1, expired: 0 });
    expect((await runNotifications(new Date())).accounts[accountId].certExpiry).toBeUndefined();

    // Eleven days on the same certificate has expired: a new stage, so it speaks again.
    const later = new Date(Date.now() + 11 * 24 * 60 * 60 * 1000);
    expect((await runNotifications(later)).accounts[accountId].certExpiry).toMatchObject({ alerted: 1, expired: 1 });
    expect((await runNotifications(later)).accounts[accountId].certExpiry).toBeUndefined();

    await authed(request(app).put(`/api/reference-options/${soon._id}`)).send({ taxExemptExpiresAt: daysFromToday(20) });
    expect((await runNotifications(new Date())).accounts[accountId].certExpiry).toMatchObject({ alerted: 1, expired: 0 });
  });

  it("says once when a record on terms goes past due, and can be switched off", async () => {
    const accountId = await subscribe();
    const business = await createBusiness({ taxExempt: false, paymentTermsDays: 15 });
    const late = (await postEntry(b2bRepair(business, { date: daysFromToday(-40) }))).body;
    await postEntry(b2bRepair(business, { date: daysFromToday(-2) }));

    const first = await runNotifications(new Date());
    expect(first.accounts[accountId].overdueInvoices).toMatchObject({ alerted: 1, total: 108.25 });
    expect((await runNotifications(new Date())).accounts[accountId].overdueInvoices).toBeUndefined();

    // A new due date is a new deadline.
    await putEntry(late._id, { paymentTermsDays: 30 });
    expect((await Entry.findById(late._id).setOptions({ allowCrossAccount: true })).overdueNotified).toBe(false);
    expect((await runNotifications(new Date())).accounts[accountId].overdueInvoices).toMatchObject({ alerted: 1 });

    const prefs = await authed(request(app).put("/api/notifications/prefs")).send({ overdueInvoices: false, certExpiry: false });
    expect(prefs.body).toMatchObject({ overdueInvoices: false, certExpiry: false, lowStock: true });
    await putEntry(late._id, { paymentTermsDays: 20 });
    expect((await runNotifications(new Date())).accounts[accountId].overdueInvoices).toBeUndefined();
  });
});

