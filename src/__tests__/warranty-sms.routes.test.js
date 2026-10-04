// End-to-end behaviour of the warranty text trigger.
//
// The property that matters most here is that a customer is never texted twice
// for the same job. A record legitimately moves Pending -> Completed -> Paid,
// and can be edited repeatedly afterwards; only the first crossing into a
// finished status may send.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";
import { SmsMessage } from "../models/SmsMessage.js";
import { SmsOptOut } from "../models/SmsOptOut.js";

let mongod;
let accountA;
let accountB;
let tokenA;

const SMS_ON = {
  enabled: true,
  dryRun: true,
  provider: "noop",
  fromNumber: "+15125550100",
  entryTypes: ["Repair"],
  businessName: "Kpital Tech",
  callbackPhone: "512-555-0100",
  reviewUrl: "g.page/r/abc"
};

function tokenFor(accountId) {
  return jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, {
    expiresIn: "1h"
  });
}

const authed = (req) => req.set("Authorization", `Bearer ${tokenA}`);

function newRepair(overrides = {}) {
  const entry = {
    type: "Repair",
    date: "2026-07-25",
    description: "PS5 HDMI port replacement",
    income: 180,
    expense: 20,
    customerName: "Jordan Rivera",
    customerPhone: "512-555-0142",
    status: "Pending",
    ...overrides
  };
  // Marking a record Paid requires a payment method (pre-existing rule).
  if (entry.status === "Paid" && !entry.paymentMethod) entry.paymentMethod = "Cash";
  return entry;
}

async function setSms(accountId, sms) {
  await Settings.updateOne({ _id: accountId }, { $set: { sms } });
}

async function logsFor(entryId) {
  return SmsMessage.find({ accountId: accountA, entryId }).lean();
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());

  const passwordHash = await bcrypt.hash("password123", 10);
  const a = await Settings.create({ key: "main", email: "a@test.com", passwordHash, emailVerified: true });
  const b = await Settings.create({ key: "b", email: "b@test.com", passwordHash, emailVerified: true });
  accountA = a._id;
  accountB = b._id;
  tokenA = tokenFor(accountA);
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await Entry.deleteMany({}).setOptions({ allowCrossAccount: true });
  await SmsMessage.deleteMany({}).setOptions({ allowCrossAccount: true });
  await SmsOptOut.deleteMany({}).setOptions({ allowCrossAccount: true });
  await setSms(accountA, SMS_ON);
  await setSms(accountB, SMS_ON);
});

describe("warranty text trigger", () => {
  it("stays silent while the job is still Pending", async () => {
    const res = await authed(request(app).post("/api/entries")).send(newRepair());
    expect(res.status).toBe(201);
    expect(res.body.warrantyNumber).toBe("");
    expect(await logsFor(res.body._id)).toHaveLength(0);
  });

  it("sends once when the job is marked Completed", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    const res = await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    expect(res.status).toBe(200);
    const logs = await logsFor(created.body._id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("dry-run");
    expect(logs[0].toNumber).toBe("+15125550142");
    expect(logs[0].segments).toBe(1);
    expect(logs[0].encoding).toBe("GSM-7");
  });

  it("does not text again when the record then moves Completed -> Paid", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Paid" });

    expect(await logsFor(created.body._id)).toHaveLength(1);
  });

  it("does not text again on later edits to a completed record", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ notes: "tested 30 min" });
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ income: 200 });

    expect(await logsFor(created.body._id)).toHaveLength(1);
  });

  it("does not re-text when a record is reopened and completed again", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Pending" });
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    // The unique index is the backstop behind the transition check.
    expect(await logsFor(created.body._id)).toHaveLength(1);
  });

  it("sends for a walk-in created straight to Paid", async () => {
    const res = await authed(request(app).post("/api/entries")).send(newRepair({ status: "Paid" }));

    expect(res.status).toBe(201);
    expect(res.body.warrantyNumber).toMatch(/^[0-9A-Z]{6}$/);
    const logs = await logsFor(res.body._id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("dry-run");
  });

  it("records why a record with no phone was skipped", async () => {
    const created = await authed(request(app).post("/api/entries")).send(
      newRepair({ customerPhone: "", customerInstagram: "jrivera" })
    );
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    const logs = await logsFor(created.body._id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("skipped");
    expect(logs[0].skipReason).toBe("no-phone");
  });

  it("honours an opt-out", async () => {
    await SmsOptOut.create({ accountId: accountA, phoneKey: "5125550142", source: "inbound-stop" });

    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    const logs = await logsFor(created.body._id);
    expect(logs[0].status).toBe("skipped");
    expect(logs[0].skipReason).toBe("opted-out");
  });

  it("skips a type that is not opted in", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair({ type: "Sales" }));
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    const logs = await logsFor(created.body._id);
    expect(logs[0].skipReason).toBe("ineligible-type");
  });

  it("sends nothing at all when the feature is switched off", async () => {
    await setSms(accountA, { ...SMS_ON, enabled: false });

    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    // Disabled short-circuits before any log row is written, so there is no
    // audit noise for accounts that never turned this on.
    expect(await logsFor(created.body._id)).toHaveLength(0);
  });
});

// The "Don't text the customer" tick on the record form. Distinct from an
// opt-out, which is the customer's decision and applies to every future job.
describe("per-record suppression", () => {
  it("does not text a walk-in created Paid with the box ticked", async () => {
    const res = await authed(request(app).post("/api/entries")).send(
      newRepair({ status: "Paid", suppressSms: true })
    );

    expect(res.status).toBe(201);
    expect(res.body.suppressSms).toBe(true);
    // The warranty code is still minted: the customer is told it in person, and
    // the code is what they quote when they call.
    expect(res.body.warrantyNumber).toMatch(/^[0-9A-Z]{6}$/);

    const logs = await logsFor(res.body._id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("skipped");
    expect(logs[0].skipReason).toBe("suppressed");
  });

  it("still honours the tick when the job completes on a later save", async () => {
    const created = await authed(request(app).post("/api/entries")).send(
      newRepair({ suppressSms: true })
    );
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    const logs = await logsFor(created.body._id);
    expect(logs[0].skipReason).toBe("suppressed");
  });

  it("leaves the tick alone on an edit that does not mention it", async () => {
    const created = await authed(request(app).post("/api/entries")).send(
      newRepair({ suppressSms: true })
    );
    const res = await authed(request(app).put(`/api/entries/${created.body._id}`)).send({
      notes: "waiting on part"
    });

    expect(res.body.suppressSms).toBe(true);
  });

  it("sends when the box is unticked on the same save that completes the job", async () => {
    const created = await authed(request(app).post("/api/entries")).send(
      newRepair({ suppressSms: true })
    );
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({
      status: "Completed",
      suppressSms: false
    });

    const logs = await logsFor(created.body._id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("dry-run");
  });

  it("lets an explicit resend override the tick", async () => {
    const created = await authed(request(app).post("/api/entries")).send(
      newRepair({ status: "Paid", suppressSms: true })
    );
    const res = await authed(request(app).post(`/api/entries/${created.body._id}/sms/resend`)).send();

    expect(res.status).toBe(200);
    expect(res.body.status).toBe("dry-run");
    const logs = await logsFor(created.body._id);
    expect(logs).toHaveLength(1);
    expect(logs[0].status).toBe("dry-run");
  });
});

describe("warranty number assignment", () => {
  it("assigns a code and a 40-day window on completion", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    const res = await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });

    expect(res.body.warrantyNumber).toMatch(/^[0-9A-Z]{6}$/);
    expect(res.body.warrantyNumber).not.toMatch(/[ILOU]/);

    const start = new Date(res.body.warrantyStartsAt);
    const end = new Date(res.body.warrantyEndsAt);
    const days = Math.round((end - start) / 86400000);
    expect(days).toBe(40);
  });

  it("keeps the same code and dates across later edits", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair());
    const first = await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });
    const second = await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ notes: "retested" });

    expect(second.body.warrantyNumber).toBe(first.body.warrantyNumber);
    expect(second.body.warrantyEndsAt).toBe(first.body.warrantyEndsAt);
  });

  it("backfills a code for a record completed before the feature existed", async () => {
    const legacy = await Entry.create({
      accountId: accountA,
      date: new Date("2026-05-01"),
      type: "Repair",
      description: "Switch joystick drift repair",
      income: 100,
      expense: 0,
      salesTax: 0,
      netProfit: 100,
      customerPhone: "512-555-0199",
      status: "Completed"
    });
    expect(legacy.warrantyNumber).toBe("");

    const res = await authed(request(app).put(`/api/entries/${legacy._id}`)).send({ notes: "touched" });
    expect(res.body.warrantyNumber).toMatch(/^[0-9A-Z]{6}$/);
  });

  it("issues distinct codes across many records", async () => {
    const codes = new Set();
    for (let i = 0; i < 25; i += 1) {
      const res = await authed(request(app).post("/api/entries")).send(
        newRepair({ status: "Paid", customerPhone: `512-555-${String(1000 + i).slice(-4)}` })
      );
      codes.add(res.body.warrantyNumber);
    }
    expect(codes.size).toBe(25);
  });
});

describe("tenancy", () => {
  it("keeps one account's SMS log invisible to another", async () => {
    const created = await authed(request(app).post("/api/entries")).send(newRepair({ status: "Paid" }));
    expect(await logsFor(created.body._id)).toHaveLength(1);

    const otherAccountRows = await SmsMessage.find({ accountId: accountB }).lean();
    expect(otherAccountRows).toHaveLength(0);
  });

  it("does not let one account's opt-out suppress another's texts", async () => {
    // Account B's customer opted out; account A texting the same number is a
    // different business relationship and must still go through.
    await SmsOptOut.create({ accountId: accountB, phoneKey: "5125550142", source: "inbound-stop" });

    const created = await authed(request(app).post("/api/entries")).send(newRepair({ status: "Paid" }));
    const logs = await logsFor(created.body._id);
    expect(logs[0].status).toBe("dry-run");
  });
});
