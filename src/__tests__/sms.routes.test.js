// SMS configuration API, the inbound STOP webhook, and manual resend.
//
// Two properties get particular attention: the settings endpoint must never
// leak carrier credentials, and enabling live sending must be gated on the
// configuration actually being complete rather than failing one customer at a
// time later.

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

const WEBHOOK_SECRET = "webhook-secret-for-tests";

function tokenFor(accountId) {
  return jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, {
    expiresIn: "1h"
  });
}

const authed = (req) => req.set("Authorization", `Bearer ${tokenA}`);

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.SMS_WEBHOOK_SECRET = WEBHOOK_SECRET;
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
  delete process.env.TELNYX_API_KEY;
});

beforeEach(async () => {
  await SmsOptOut.deleteMany({}).setOptions({ allowCrossAccount: true });
  await SmsMessage.deleteMany({}).setOptions({ allowCrossAccount: true });
  await Entry.deleteMany({}).setOptions({ allowCrossAccount: true });
  await Settings.updateOne(
    { _id: accountA },
    {
      $set: {
        sms: {
          enabled: false,
          dryRun: true,
          provider: "noop",
          fromNumber: "",
          entryTypes: ["Repair"],
          businessName: "Kpital Tech",
          callbackPhone: "512-555-0100",
          reviewUrl: "g.page/r/abc",
          template: "{business}: Repair #{warranty} done. {days}-day warranty thru {expires}. Call {phone}. Review: {review} Reply STOP to end"
        }
      }
    }
  );
  delete process.env.TELNYX_API_KEY;
});

describe("GET /api/sms/settings", () => {
  it("returns the config without any credentials", async () => {
    const res = await authed(request(app).get("/api/sms/settings"));

    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe("Kpital Tech");
    expect(res.body.warrantyDays).toBe(40);
    // Nothing secret may appear anywhere in the payload.
    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toMatch(/apiKey|api_key|authToken|accountSid|TELNYX|TWILIO/i);
    expect(res.body).toHaveProperty("providerConfigured");
  });

  it("requires authentication", async () => {
    const res = await request(app).get("/api/sms/settings");
    expect(res.status).toBe(401);
  });
});

describe("PUT /api/sms/settings", () => {
  it("saves editable fields", async () => {
    const res = await authed(request(app).put("/api/sms/settings")).send({
      businessName: "Kpital",
      reviewUrl: "g.page/r/xyz",
      entryTypes: ["Repair", "Sales"],
      fromNumber: "(512) 555-0100"
    });

    expect(res.status).toBe(200);
    expect(res.body.businessName).toBe("Kpital");
    expect(res.body.entryTypes).toEqual(["Repair", "Sales"]);
    // Stored in E.164 regardless of how it was typed.
    expect(res.body.fromNumber).toBe("+15125550100");
  });

  it("rejects an invalid sending number", async () => {
    const res = await authed(request(app).put("/api/sms/settings")).send({ fromNumber: "555" });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown provider and unknown record types", async () => {
    expect((await authed(request(app).put("/api/sms/settings")).send({ provider: "pigeon" })).status).toBe(400);
    expect((await authed(request(app).put("/api/sms/settings")).send({ entryTypes: ["Nonsense"] })).status).toBe(400);
    expect((await authed(request(app).put("/api/sms/settings")).send({ entryTypes: [] })).status).toBe(400);
  });

  it("rejects an empty template", async () => {
    const res = await authed(request(app).put("/api/sms/settings")).send({ template: "   " });
    expect(res.status).toBe(400);
  });

  it("allows enabling while still in dry run, with nothing configured", async () => {
    const res = await authed(request(app).put("/api/sms/settings")).send({ dryRun: true, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(true);
  });

  it("refuses to go live without a sending number", async () => {
    const res = await authed(request(app).put("/api/sms/settings")).send({ dryRun: false, enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sending number/i);
  });

  it("refuses to go live when carrier credentials are missing", async () => {
    await authed(request(app).put("/api/sms/settings")).send({
      fromNumber: "512-555-0100",
      provider: "telnyx"
    });

    const res = await authed(request(app).put("/api/sms/settings")).send({ dryRun: false, enabled: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/credentials/i);
  });

  it("goes live once the number and credentials are both present", async () => {
    process.env.TELNYX_API_KEY = "test-key";
    await authed(request(app).put("/api/sms/settings")).send({
      fromNumber: "512-555-0100",
      provider: "telnyx"
    });

    const res = await authed(request(app).put("/api/sms/settings")).send({ dryRun: false, enabled: true });
    expect(res.status).toBe(200);
    expect(res.body.enabled).toBe(true);
    expect(res.body.dryRun).toBe(false);
  });
});

describe("POST /api/sms/preview", () => {
  it("renders the saved template with sample values and counts segments", async () => {
    const res = await authed(request(app).post("/api/sms/preview")).send({});

    expect(res.status).toBe(200);
    expect(res.body.body).toContain("K7X2M9");
    expect(res.body.body).toContain("Kpital Tech");
    expect(res.body.segments).toBe(1);
    expect(res.body.encoding).toBe("GSM-7");
  });

  it("previews unsaved edits without persisting them", async () => {
    const res = await authed(request(app).post("/api/sms/preview")).send({
      template: "{business} says hi 🎮",
      businessName: "Draft Name"
    });

    expect(res.body.body).toBe("Draft Name says hi 🎮");
    // The emoji is surfaced as the reason this would cost more.
    expect(res.body.encoding).toBe("UCS-2");
    expect(res.body.offenders).toContain("🎮");

    const saved = await authed(request(app).get("/api/sms/settings"));
    expect(saved.body.businessName).toBe("Kpital Tech");
  });
});

describe("POST /api/sms/inbound/:accountId", () => {
  const post = (accountId, body) =>
    request(app).post(`/api/sms/inbound/${accountId}`).set("x-sms-webhook-secret", WEBHOOK_SECRET).send(body);

  it("rejects a request without the shared secret", async () => {
    const res = await request(app).post(`/api/sms/inbound/${accountA}`).send({ From: "+15125550142", Body: "STOP" });
    expect(res.status).toBe(401);
  });

  it("records an opt-out from a Twilio-shaped payload", async () => {
    const res = await post(accountA, { From: "+1 (512) 555-0142", Body: "STOP" });

    expect(res.body.action).toBe("opted-out");
    const row = await SmsOptOut.findOne({ accountId: accountA, phoneKey: "5125550142" }).lean();
    expect(row).toBeTruthy();
    expect(row.keyword).toBe("STOP");
  });

  it("records an opt-out from a Telnyx-shaped payload", async () => {
    const res = await post(accountA, {
      data: { payload: { from: { phone_number: "+15125550143" }, text: "stop" } }
    });

    expect(res.body.action).toBe("opted-out");
    expect(await SmsOptOut.findOne({ accountId: accountA, phoneKey: "5125550143" }).lean()).toBeTruthy();
  });

  it("accepts the other opt-out keywords", async () => {
    for (const [i, word] of ["UNSUBSCRIBE", "CANCEL", "END", "QUIT", "STOPALL"].entries()) {
      const phone = `+1512555${String(2000 + i).slice(-4)}`;
      const res = await post(accountA, { From: phone, Body: word });
      expect(res.body.action, word).toBe("opted-out");
    }
  });

  it("re-subscribes on START", async () => {
    await post(accountA, { From: "+15125550142", Body: "STOP" });
    const res = await post(accountA, { From: "+15125550142", Body: "START" });

    expect(res.body.action).toBe("opted-in");
    expect(await SmsOptOut.findOne({ accountId: accountA, phoneKey: "5125550142" }).lean()).toBeNull();
  });

  it("ignores ordinary replies", async () => {
    const res = await post(accountA, { From: "+15125550142", Body: "thanks, works great!" });
    expect(res.body.action).toBe("ignored");
    expect(await SmsOptOut.countDocuments({ accountId: accountA })).toBe(0);
  });

  it("is idempotent for a repeated STOP", async () => {
    await post(accountA, { From: "+15125550142", Body: "STOP" });
    await post(accountA, { From: "+15125550142", Body: "STOP" });
    expect(await SmsOptOut.countDocuments({ accountId: accountA, phoneKey: "5125550142" })).toBe(1);
  });

  it("scopes the opt-out to the account named in the path", async () => {
    await post(accountA, { From: "+15125550142", Body: "STOP" });

    expect(await SmsOptOut.countDocuments({ accountId: accountA })).toBe(1);
    expect(await SmsOptOut.countDocuments({ accountId: accountB })).toBe(0);
  });

  it("acknowledges a payload with no usable sender rather than failing", async () => {
    const res = await post(accountA, { nonsense: true });
    expect(res.status).toBe(200);
    expect(res.body.action).toBe("ignored");
  });
});

describe("POST /api/entries/:id/sms/resend", () => {
  async function completedRepair() {
    await authed(request(app).put("/api/sms/settings")).send({ enabled: true, dryRun: true });
    const created = await authed(request(app).post("/api/entries")).send({
      type: "Repair",
      date: "2026-07-25",
      description: "PS5 HDMI port replacement",
      income: 180,
      expense: 20,
      customerName: "Jordan Rivera",
      customerPhone: "512-555-0142",
      status: "Pending"
    });
    await authed(request(app).put(`/api/entries/${created.body._id}`)).send({ status: "Completed" });
    return created.body._id;
  }

  it("sends again after clearing the previous attempt", async () => {
    const id = await completedRepair();
    expect(await SmsMessage.countDocuments({ accountId: accountA, entryId: id })).toBe(1);

    const res = await authed(request(app).post(`/api/entries/${id}/sms/resend`)).send({});
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("dry-run");
    // Still exactly one row: the old claim is replaced, not appended.
    expect(await SmsMessage.countDocuments({ accountId: accountA, entryId: id })).toBe(1);
  });

  it("lists the attempt history for a record", async () => {
    const id = await completedRepair();
    const res = await authed(request(app).get(`/api/entries/${id}/sms`));

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].status).toBe("dry-run");
    expect(res.body[0].segments).toBe(1);
  });

  it("refuses to resend for a record with no warranty number", async () => {
    await authed(request(app).put("/api/sms/settings")).send({ enabled: true, dryRun: true });
    const created = await authed(request(app).post("/api/entries")).send({
      type: "Repair",
      date: "2026-07-25",
      description: "Pending job",
      income: 100,
      expense: 0,
      customerName: "Jordan Rivera",
      customerPhone: "512-555-0142",
      status: "Pending"
    });

    const res = await authed(request(app).post(`/api/entries/${created.body._id}/sms/resend`)).send({});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/warranty number/i);
  });

  it("404s for another account's record", async () => {
    const foreign = await Entry.create({
      accountId: accountB,
      date: new Date(),
      type: "Repair",
      description: "not yours",
      income: 10,
      expense: 0,
      salesTax: 0,
      netProfit: 10,
      status: "Completed",
      warrantyNumber: "ZZZZZZ"
    });
    await authed(request(app).put("/api/sms/settings")).send({ enabled: true, dryRun: true });

    const res = await authed(request(app).post(`/api/entries/${foreign._id}/sms/resend`)).send({});
    expect(res.status).toBe(404);
  });
});
