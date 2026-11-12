// Receipt photos on records, with Cloud Storage stood in for at the fetch level.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../app.js";
import { Entry } from "../models/Entry.js";
import { sniffImage } from "../services/receiptService.js";

let mongod;
let bucket;
const accountA = new mongoose.Types.ObjectId();
const accountB = new mongoose.Types.ObjectId();
const tokenFor = (accountId) => jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, { expiresIn: "1h" });
const as = (accountId, req) => req.set("Authorization", `Bearer ${tokenFor(accountId)}`);

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 9)]);

// A stand-in bucket: name -> bytes.
function fakeBucket() {
  const objects = new Map();
  vi.stubGlobal("fetch", async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") return Response.json({ access_token: "t" });
    if (url.pathname.startsWith("/upload/")) {
      objects.set(url.searchParams.get("name"), Buffer.from(init.body));
      return Response.json({});
    }
    const name = decodeURIComponent(url.pathname.split("/o/")[1]);
    if (init.method === "DELETE") {
      objects.delete(name);
      return new Response(null, { status: 204 });
    }
    return objects.has(name) ? new Response(objects.get(name)) : new Response("missing", { status: 404 });
  });
  return objects;
}

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  await mongoose.connect(mongod.getUri());
});
afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

let expense;
beforeEach(async () => {
  await Entry.collection.deleteMany({});
  process.env.RECEIPTS_BUCKET = "receipts-bucket";
  bucket = fakeBucket();
  expense = await Entry.create({ accountId: accountA, date: new Date("2026-11-01"), type: "Expenses", description: "Solder", expense: 20, netProfit: -20 });
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.RECEIPTS_BUCKET;
});

const upload = (accountId, id, bytes, type = "image/jpeg") =>
  as(accountId, request(app).post(`/api/entries/${id}/receipt`)).set("Content-Type", type).send(bytes);

describe("receipt photos", () => {
  it("stores a photo on a record and serves it back to its owner only", async () => {
    const res = await upload(accountA, expense._id, JPEG);
    expect(res.status).toBe(201);
    expect(res.body.receipt).toMatchObject({ contentType: "image/jpeg", size: JPEG.length });
    expect(res.body.receipt.path).toMatch(new RegExp(`^receipts/${accountA}/${expense._id}-[0-9a-f]{12}\\.jpg$`));
    expect(bucket.size).toBe(1);

    const view = await as(accountA, request(app).get(`/api/entries/${expense._id}/receipt`)).buffer(true).parse((r, cb) => {
      const chunks = [];
      r.on("data", (chunk) => chunks.push(chunk));
      r.on("end", () => cb(null, Buffer.concat(chunks)));
    });
    expect(view.status).toBe(200);
    expect(view.headers["content-type"]).toBe("image/jpeg");
    expect(view.headers["cache-control"]).toContain("private");
    expect(view.body.equals(JPEG)).toBe(true);

    // Another account cannot see it, add to it or remove it.
    expect((await as(accountB, request(app).get(`/api/entries/${expense._id}/receipt`))).status).toBe(404);
    expect((await upload(accountB, expense._id, JPEG)).status).toBe(404);
    expect((await as(accountB, request(app).delete(`/api/entries/${expense._id}/receipt`))).status).toBe(404);
    expect((await request(app).get(`/api/entries/${expense._id}/receipt`)).status).toBe(401);

    // The record's money is untouched.
    const saved = await Entry.findOne({ _id: expense._id, accountId: accountA }).lean();
    expect(saved).toMatchObject({ expense: 20, netProfit: -20 });
  });

  it("replaces the old photo, and removes it with the record", async () => {
    const first = await upload(accountA, expense._id, JPEG);
    const second = await upload(accountA, expense._id, PNG, "image/png");
    expect(second.body.receipt.contentType).toBe("image/png");
    expect([...bucket.keys()]).toEqual([second.body.receipt.path]);
    expect(second.body.receipt.path).not.toBe(first.body.receipt.path);

    expect((await as(accountA, request(app).delete(`/api/entries/${expense._id}`))).status).toBe(200);
    expect(bucket.size).toBe(0);
  });

  it("takes the photo off on request", async () => {
    await upload(accountA, expense._id, JPEG);
    expect((await as(accountA, request(app).delete(`/api/entries/${expense._id}/receipt`))).status).toBe(200);
    expect(bucket.size).toBe(0);
    expect((await as(accountA, request(app).get(`/api/entries/${expense._id}/receipt`))).status).toBe(404);
    expect((await Entry.findOne({ _id: expense._id, accountId: accountA }).lean()).receipt).toBeUndefined();
  });

  it("refuses what is not a photo, what is too big, and says so when not set up", async () => {
    // Claims to be a JPEG; is not one.
    expect((await upload(accountA, expense._id, Buffer.from("<html>not a photo</html>"))).status).toBe(400);
    // Not sent as an image at all.
    expect((await upload(accountA, expense._id, JSON.stringify({ a: 1 }), "application/json")).status).toBe(400);
    expect((await upload(accountA, expense._id, Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)]))).status).toBe(413);
    expect(bucket.size).toBe(0);

    delete process.env.RECEIPTS_BUCKET;
    const off = await upload(accountA, expense._id, JPEG);
    expect(off.status).toBe(503);
    expect(off.body.message).toBe("Receipt photos are not set up yet.");
  });

  it("tells a photo by its bytes", () => {
    expect(sniffImage(JPEG)).toEqual({ contentType: "image/jpeg", extension: "jpg" });
    expect(sniffImage(PNG)).toEqual({ contentType: "image/png", extension: "png" });
    expect(sniffImage(Buffer.concat([Buffer.from("RIFF0000WEBP"), Buffer.alloc(8)]))).toEqual({ contentType: "image/webp", extension: "webp" });
    expect(sniffImage(Buffer.from("GIF89a-not-accepted"))).toBeNull();
  });
});
