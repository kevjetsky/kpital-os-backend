import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";
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
  // dropDatabase takes the unique indexes with it.
  await Promise.all([Entry.syncIndexes(), ReferenceOption.syncIndexes()]);
  await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  const login = await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" });
  token = login.body.token;
});

const authed = (req) => req.set("Authorization", `Bearer ${token}`);
const postEntry = (body) => authed(request(app).post("/api/entries")).send(body);
const putEntry = (id, body) => authed(request(app).put(`/api/entries/${id}`)).send(body);
const repair = (overrides = {}) => ({
  type: "Repair",
  date: "2026-10-01",
  description: "HDMI port",
  income: 100,
  customerPhone: "555-0101",
  ...overrides
});
const expense = (overrides = {}) => ({ type: "Expenses", date: "2026-10-01", description: "Solder", expense: 20, ...overrides });

async function service(overrides = {}) {
  const res = await authed(request(app).post("/api/reference-options")).send({
    kind: "product_service",
    name: "HDMI Port Repair",
    optionType: "service",
    price: 140,
    cost: 12,
    ...overrides
  });
  expect(res.status).toBe(201);
  return res.body;
}

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("business profile", () => {
  it("is kept on the account, with a logo and the sales tax rate", async () => {
    const empty = await authed(request(app).get("/api/business-profile"));
    expect(empty.body).toEqual({
      name: "", phone: "", email: "", address: "", website: "", logo: "", salesTaxRate: 0.0825, salesTaxRateSet: false
    });

    const saved = await authed(request(app).put("/api/business-profile")).send({
      name: "We Fix Consoles",
      phone: "(346) 667-4364",
      website: "we-fix-consoles.com",
      logo: PNG,
      salesTaxRate: 0.0825
    });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ name: "We Fix Consoles", logo: PNG, salesTaxRate: 0.0825, salesTaxRateSet: true });

    // A partial update leaves the rest alone.
    const renamed = await authed(request(app).put("/api/business-profile")).send({ email: "hi@example.com" });
    expect(renamed.body).toMatchObject({ name: "We Fix Consoles", email: "hi@example.com", logo: PNG });
  });

  it("refuses a logo that is not a small image, and a rate out of range", async () => {
    const put = (body) => authed(request(app).put("/api/business-profile")).send(body);
    expect((await put({ logo: "https://example.com/logo.png" })).status).toBe(400);
    expect((await put({ logo: "data:image/svg+xml;base64,PHN2Zz4=" })).status).toBe(400);
    expect((await put({ logo: `data:image/png;base64,${"A".repeat(210_000)}` })).status).toBe(400);
    expect((await put({ salesTaxRate: 0.5 })).status).toBe(400);
    expect((await put({ salesTaxRate: "x" })).status).toBe(400);
    expect((await put({ logo: "" })).status).toBe(200);
  });

  it("taxes new records at the account's rate, and an edit keeps the record's own rate", async () => {
    await authed(request(app).put("/api/business-profile")).send({ salesTaxRate: 0.1 });
    const created = (await postEntry(repair())).body;
    expect(created).toMatchObject({ salesTax: 10, taxRate: 0.1 });

    await authed(request(app).put("/api/business-profile")).send({ salesTaxRate: 0.07 });
    const edited = (await putEntry(created._id, { income: 200 })).body;
    expect(edited).toMatchObject({ salesTax: 20, taxRate: 0.1 });
    expect((await postEntry(repair())).body.salesTax).toBe(7);
  });

  it("works out the rate of a record saved before rates were stored", async () => {
    const created = (await postEntry(repair({ income: 33 }))).body;
    // As an older record would be: rounded tax, no stored rate.
    await Entry.updateOne({ _id: created._id }, { $unset: { taxRate: 1 } }).setOptions({ allowCrossAccount: true });
    const edited = (await putEntry(created._id, { income: 1000 })).body;
    expect(edited).toMatchObject({ salesTax: 82.5, taxRate: 0.0825 });
  });
});

describe("invoice numbers", () => {
  it("numbers sales, repairs and refunds in order, and nothing paid out", async () => {
    const first = (await postEntry(repair())).body;
    const sale = (await postEntry(repair({ type: "Sales" }))).body;
    const cost = (await postEntry(expense())).body;
    const refund = (await postEntry({ type: "Refund", date: "2026-10-02", description: "Refund", expense: 20 })).body;

    expect([first.invoiceNumber, sale.invoiceNumber, refund.invoiceNumber]).toEqual(["INV-1001", "INV-1002", "INV-1003"]);
    expect(cost.invoiceNumber).toBe("");

    // Becoming a sale gets the next number; a number is never handed out twice.
    const retyped = (await putEntry(cost._id, { type: "Sales", income: 50, customerPhone: "555-0102" })).body;
    expect(retyped.invoiceNumber).toBe("INV-1004");
    await authed(request(app).delete(`/api/entries/${first._id}`));
    expect((await postEntry(repair())).body.invoiceNumber).toBe("INV-1005");

    const found = await authed(request(app).get("/api/entries?search=INV-1002"));
    expect(found.body.map((entry) => entry._id)).toEqual([sale._id]);
  });

  it("numbers existing records by date with the migration, which can run again safely", async () => {
    const make = (date, type = "Repair") =>
      Entry.create({ accountId: new mongoose.Types.ObjectId(), date, type, income: 10, status: "Paid" });
    const account = await Settings.findOne({ email: "owner@example.com" });
    const old = await Promise.all([
      Entry.create({ accountId: account._id, date: new Date("2026-03-02"), type: "Repair", income: 10, status: "Paid" }),
      Entry.create({ accountId: account._id, date: new Date("2026-01-15"), type: "Sales", income: 10, status: "Paid" }),
      Entry.create({ accountId: account._id, date: new Date("2026-02-01"), type: "Expenses", expense: 10, status: "Paid" })
    ]);
    await make(new Date("2026-01-01")); // another account, numbered on its own

    const run = () => execFileSync("node", ["scripts/migrate-invoice-numbers.mjs"], { env: { ...process.env, MONGODB_URI: mongod.getUri() } }).toString();
    run();
    const numberOf = async (doc) => (await Entry.findById(doc._id).setOptions({ allowCrossAccount: true })).invoiceNumber;
    expect(await numberOf(old[1])).toBe("INV-1001");
    expect(await numberOf(old[0])).toBe("INV-1002");
    expect(await numberOf(old[2])).toBe("");

    run();
    expect(await numberOf(old[0])).toBe("INV-1002");
    expect((await postEntry(repair())).body.invoiceNumber).toBe("INV-1003");
  });
});

describe("notes", () => {
  it("keeps internal notes apart from the note printed on the invoice", async () => {
    const created = (await postEntry(repair({ notes: "Customer was rude", invoiceNote: "Thanks for choosing us!" }))).body;
    expect(created).toMatchObject({ notes: "Customer was rude", invoiceNote: "Thanks for choosing us!" });
    const edited = (await putEntry(created._id, { invoiceNote: "" })).body;
    expect(edited).toMatchObject({ notes: "Customer was rude", invoiceNote: "" });
  });
});

describe("customer names", () => {
  const customers = () => ReferenceOption.find({ kind: "customer" }).setOptions({ allowCrossAccount: true }).lean();

  it("stores first and last name, and splits a single name", async () => {
    const parts = await authed(request(app).post("/api/reference-options")).send({
      kind: "customer", firstName: "Jordan", lastName: "Alvarez", phone: "555-0101"
    });
    expect(parts.body).toMatchObject({ name: "Jordan Alvarez", firstName: "Jordan", lastName: "Alvarez" });

    const single = await authed(request(app).post("/api/reference-options")).send({ kind: "customer", name: "Sam Lee Jr", phone: "555-0102" });
    expect(single.body).toMatchObject({ firstName: "Sam", lastName: "Lee Jr" });

    const renamed = await authed(request(app).put(`/api/reference-options/${parts.body._id}`)).send({ lastName: "Reyes" });
    expect(renamed.body).toMatchObject({ name: "Jordan Reyes", firstName: "Jordan", lastName: "Reyes" });
  });

  it("names a customer first saved under their phone once a job gives the name", async () => {
    await postEntry(repair({ customerPhone: "555-0199" }));
    expect((await customers())[0]).toMatchObject({ name: "555-0199", firstName: "" });

    await postEntry(repair({ customerPhone: "555-0199", customerName: "Ana Diaz" }));
    expect((await customers())[0]).toMatchObject({ name: "Ana Diaz", firstName: "Ana", lastName: "Diaz" });

    // A real name on file is not replaced by whatever the next job types.
    await postEntry(repair({ customerPhone: "555-0199", customerName: "Someone Else" }));
    expect((await customers())[0].name).toBe("Ana Diaz");
  });
});

describe("job and payment status", () => {
  it("keeps the old status in step with job status and payment", async () => {
    const booked = (await postEntry(repair({ jobStatus: "Booked" }))).body;
    expect(booked).toMatchObject({ jobStatus: "Booked", status: "Pending", warrantyNumber: "" });

    const ready = (await putEntry(booked._id, { jobStatus: "Ready" })).body;
    expect(ready).toMatchObject({ jobStatus: "Ready", status: "Completed" });
    // Finishing the work starts the warranty.
    expect(ready.warrantyNumber).not.toBe("");

    const paid = (await putEntry(booked._id, { status: "Paid", paymentMethod: "Zelle" })).body;
    expect(paid).toMatchObject({ jobStatus: "Ready", status: "Paid" });

    const unpaid = (await putEntry(booked._id, { paid: false })).body;
    expect(unpaid).toMatchObject({ jobStatus: "Ready", status: "Completed" });

    // Paid up front for work not started yet.
    const deposit = (await postEntry(repair({ jobStatus: "In progress", status: "Paid", paymentMethod: "Cash" }))).body;
    expect(deposit).toMatchObject({ jobStatus: "In progress", status: "Paid" });
  });

  it("reads the old status as job progress for callers that only send that", async () => {
    expect((await postEntry(repair())).body).toMatchObject({ jobStatus: "In progress", status: "Pending" });
    expect((await postEntry(repair({ status: "Completed" }))).body).toMatchObject({ jobStatus: "Done", status: "Completed" });
    expect((await postEntry(repair({ status: "Paid", paymentMethod: "Cash" }))).body).toMatchObject({ jobStatus: "Done", status: "Paid" });
    expect((await postEntry(repair({ jobStatus: "Finished" }))).status).toBe(400);
  });

  it("filters by job status, counting records saved before it existed, and counts open and unpaid jobs", async () => {
    await postEntry(repair({ jobStatus: "Booked" }));
    await postEntry(repair({ jobStatus: "Done", status: "Paid", paymentMethod: "Cash" }));
    await postEntry(repair({ jobStatus: "Ready" }));
    await postEntry(expense({ status: "Pending" }));
    const account = await Settings.findOne({ email: "owner@example.com" });
    // Older records: no job status.
    await Entry.create({ accountId: account._id, date: new Date("2026-10-01"), type: "Repair", income: 5, status: "Pending" });
    await Entry.create({ accountId: account._id, date: new Date("2026-10-01"), type: "Repair", income: 5, status: "Completed" });

    const count = async (filter) => (await authed(request(app).get(`/api/entries?jobStatus=${encodeURIComponent(filter)}`))).body.length;
    expect(await count("In progress")).toBe(2); // the expense (no job status given) and the old Pending one
    expect(await count("Done")).toBe(2);
    expect(await count("Booked,Ready")).toBe(2);
    expect((await authed(request(app).get("/api/entries?jobStatus=Nope"))).status).toBe(400);

    const summary = await authed(request(app).get("/api/entries/summary?from=2026-10-01&to=2026-10-31"));
    expect(summary.body).toMatchObject({ openJobs: 3, unpaidJobs: 4 });
  });
});

describe("line items", () => {
  it("prices a job from its lines and names its first product", async () => {
    const hdmi = await service();
    const cleaning = await service({ name: "Deep Clean", price: 35, cost: 0 });
    const res = await postEntry(
      repair({
        income: 1, // ignored: the lines are the price
        items: [
          { productServiceOptionId: hdmi._id },
          { productServiceOptionId: cleaning._id, quantity: 2, unitPrice: 30 },
          { name: "Thermal paste", quantity: 1, unitPrice: 9.99 }
        ]
      })
    );
    expect(res.status).toBe(201);
    expect(res.body.items).toEqual([
      { productServiceOptionId: hdmi._id, name: "HDMI Port Repair", optionType: "service", quantity: 1, unitPrice: 140 },
      { productServiceOptionId: cleaning._id, name: "Deep Clean", optionType: "service", quantity: 2, unitPrice: 30 },
      { productServiceOptionId: null, name: "Thermal paste", optionType: "", quantity: 1, unitPrice: 9.99 }
    ]);
    expect(res.body).toMatchObject({
      income: 209.99,
      salesTax: 17.32,
      productServiceName: "HDMI Port Repair",
      productServiceOptionId: hdmi._id,
      productServicePrice: 140
    });
  });

  it("uses a product's B2B price on a B2B job", async () => {
    const hdmi = await service({ b2bPrice: 100 });
    const business = await authed(request(app).post("/api/reference-options")).send({ kind: "business", name: "GameStop" });
    const res = await postEntry({
      type: "Repair", date: "2026-10-01", isB2B: true, businessOptionId: business.body._id,
      items: [{ productServiceOptionId: hdmi._id, quantity: 3 }]
    });
    expect(res.body).toMatchObject({ income: 300, items: [{ unitPrice: 100, quantity: 3 }] });
  });

  it("refuses lines it cannot price or name", async () => {
    const bad = async (items) => (await postEntry(repair({ items }))).status;
    expect(await bad([{ quantity: 1, unitPrice: 5 }])).toBe(400);
    expect(await bad([{ name: "x", quantity: 0 }])).toBe(400);
    expect(await bad([{ name: "x", unitPrice: -1 }])).toBe(400);
    expect(await bad([{ productServiceOptionId: String(new mongoose.Types.ObjectId()) }])).toBe(400);
    expect(await bad("lots")).toBe(400);
  });

  it("keeps lines through other edits, follows a new price on a single line, and drops them on an expense", async () => {
    const one = (await postEntry(repair({ items: [{ name: "Stick swap", quantity: 2, unitPrice: 40 }] }))).body;
    expect((await putEntry(one._id, { jobStatus: "Done" })).body).toMatchObject({ income: 80, items: [{ unitPrice: 40 }] });
    expect((await putEntry(one._id, { income: 100 })).body).toMatchObject({ income: 100, items: [{ quantity: 2, unitPrice: 50 }] });

    const two = (await postEntry(repair({ items: [{ name: "A", unitPrice: 10 }, { name: "B", unitPrice: 20 }] }))).body;
    const total = await putEntry(two._id, { income: 99 });
    expect(total.status).toBe(400);
    const relined = (await putEntry(two._id, { items: [{ name: "A", unitPrice: 15 }] })).body;
    expect(relined).toMatchObject({ income: 15, items: [{ name: "A" }] });

    const asExpense = (await putEntry(two._id, { type: "Expenses", expense: 15 })).body;
    expect(asExpense.items).toEqual([]);
  });
});

describe("device", () => {
  it("keeps the console's details on a repair, finds it by serial, and drops them on an expense", async () => {
    const res = await postEntry(
      repair({
        deviceModel: "PS5 Slim",
        deviceSerial: " ab12 cd34 ",
        problemReported: "No video",
        deviceCondition: "Scratched top",
        deviceAccessories: "Power cable"
      })
    );
    expect(res.body).toMatchObject({
      deviceModel: "PS5 Slim",
      deviceSerial: "AB12CD34",
      problemReported: "No video",
      deviceCondition: "Scratched top",
      deviceAccessories: "Power cable"
    });

    const bySerial = await authed(request(app).get("/api/entries?search=ab12cd34"));
    expect(bySerial.body).toHaveLength(1);

    const edited = (await putEntry(res.body._id, { deviceCondition: "" })).body;
    expect(edited).toMatchObject({ deviceModel: "PS5 Slim", deviceCondition: "" });

    const cost = (await postEntry(expense({ deviceSerial: "XYZ" }))).body;
    expect(cost.deviceSerial).toBe("");
  });

  it("offers a console's earlier repair as a warranty return, whoever brings it in", async () => {
    const first = (await postEntry(repair({ deviceSerial: "SN-777", customerPhone: "555-0101", date: "2026-10-01" }))).body;
    await postEntry(repair({ deviceSerial: "SN-888", customerPhone: "555-0101", date: "2026-10-02" }));

    const res = await authed(request(app).get("/api/entries/warranty-candidates?serial=sn-777&date=2026-10-20"));
    expect(res.body.matchedBy).toBe("serial");
    expect(res.body.candidates.map((c) => c._id)).toEqual([first._id]);
    expect(res.body.candidates[0]).toMatchObject({ deviceSerial: "SN-777", invoiceNumber: "INV-1001" });
  });
});

describe("shared lists", () => {
  it("publishes the lists the API accepts, without a sign-in", async () => {
    const res = await request(app).get("/api/meta");
    expect(res.status).toBe(200);
    expect(res.body.expenseCategories).toContain("Shipping");
    expect(res.body.paymentMethods).toContain("Zelle");
    expect(res.body.entryTypes).toEqual(["Sales", "Repair", "Expenses", "Refund", "Payroll", "Owner Draw"]);
    expect(res.body.jobStatuses).toEqual(["Booked", "In progress", "Ready", "Done"]);
  });

  it("keeps Shipping as an expense category", async () => {
    const res = await postEntry(expense({ category: "Shipping" }));
    expect(res.status).toBe(201);
    expect(res.body.category).toBe("Shipping");
  });
});

describe("one routine for create and update", () => {
  it("numbers invoices without gaps when a save is refused", async () => {
    const first = await postEntry(repair());
    // Refused before anything is saved: no number is used up.
    const refused = await postEntry(repair({ customerPhone: "", customerInstagram: "" }));
    expect(refused.status).toBe(400);
    const second = await postEntry(repair());
    expect(first.body.invoiceNumber).toBe("INV-1001");
    expect(second.body.invoiceNumber).toBe("INV-1002");
  });

  it("gives a record its number when an update turns it into a job", async () => {
    const made = await postEntry(expense());
    expect(made.body.invoiceNumber || "").toBe("");
    const changed = await putEntry(made.body._id, { type: "Sales", customerPhone: "555-0102", income: 30 });
    expect(changed.status).toBe(200);
    expect(changed.body.invoiceNumber).toBe("INV-1001");
  });

  it("leaves fields the update does not mention as they were", async () => {
    const made = await postEntry(repair({ notes: "Left at the door", invoiceNote: "90-day warranty", deviceModel: "PS5" }));
    const changed = await putEntry(made.body._id, { jobStatus: "Ready" });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({
      notes: "Left at the door",
      invoiceNote: "90-day warranty",
      deviceModel: "PS5",
      income: 100,
      jobStatus: "Ready",
      customerPhone: "555-0101"
    });
  });
});
