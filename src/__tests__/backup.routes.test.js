// The nightly backup (cron secret, Cloud Storage) and the owner's own export.
// Cloud Storage is a stubbed fetch: nothing here leaves the machine.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { gunzipSync } from "node:zlib";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import app from "../app.js";
import { Entry } from "../models/Entry.js";
import { RecurringEntry } from "../models/RecurringEntry.js";
import { TaxRemittance } from "../models/TaxRemittance.js";
import { dumpDatabase, readDump, restoreDump, runBackup } from "../services/backupService.js";

let mongod;
const accountA = new mongoose.Types.ObjectId();
const accountB = new mongoose.Types.ObjectId();

const tokenFor = (accountId) =>
  jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, { expiresIn: "1h" });

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A stand-in bucket: records uploads and deletes, lists what it holds.
function fakeStorage(existing = []) {
  const objects = new Map(existing.map((name) => [name, null]));
  const deleted = [];
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.hostname === "metadata.google.internal") return json({ access_token: "test-token" });
    expect(init.headers.Authorization).toBe("Bearer test-token");
    if (url.pathname.startsWith("/upload/")) {
      objects.set(url.searchParams.get("name"), init.body);
      return json({});
    }
    if (init.method === "DELETE") {
      const name = decodeURIComponent(url.pathname.split("/o/")[1]);
      objects.delete(name);
      deleted.push(name);
      return new Response(null, { status: 204 });
    }
    return json({ items: [...objects.keys()].map((name) => ({ name })) });
  });
  return { fetchImpl, objects, deleted };
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

beforeEach(async () => {
  // Straight to the driver: the models refuse a delete that names no account.
  await Promise.all([Entry, RecurringEntry, TaxRemittance].map((model) => model.collection.deleteMany({})));
  await Entry.create([
    { accountId: accountA, date: new Date("2026-03-01"), type: "Sales", income: 100, netProfit: 100 },
    { accountId: accountB, date: new Date("2026-03-02"), type: "Sales", income: 50, netProfit: 50 }
  ]);
});

afterEach(() => {
  delete process.env.CRON_SECRET;
  delete process.env.BACKUP_BUCKET;
});

describe("runBackup", () => {
  it("uploads a gzipped dump of every account that restores ids and dates", async () => {
    const storage = fakeStorage();
    const result = await runBackup({
      env: { BACKUP_BUCKET: "bucket" },
      fetchImpl: storage.fetchImpl,
      now: new Date("2026-11-10T08:00:00.000Z")
    });

    expect(result.file).toBe("kpital-backup-2026-11-10T08-00-00-000Z.json.gz");
    expect(result.counts.entries).toBe(2);
    expect(result.pruned).toBe(0);

    const { EJSON } = mongoose.mongo.BSON;
    const dump = EJSON.parse(gunzipSync(storage.objects.get(result.file)).toString("utf8"));
    expect(dump.collections.entries).toHaveLength(2);
    expect(dump.collections.entries[0]._id).toBeInstanceOf(mongoose.mongo.ObjectId);
    expect(dump.collections.entries[0].date).toBeInstanceOf(Date);
  });

  it("keeps only the newest dumps once the upload has succeeded", async () => {
    const storage = fakeStorage([
      "kpital-backup-2026-11-07T08-00-00-000Z.json.gz",
      "kpital-backup-2026-11-08T08-00-00-000Z.json.gz",
      "kpital-backup-2026-11-09T08-00-00-000Z.json.gz"
    ]);
    const result = await runBackup({
      env: { BACKUP_BUCKET: "bucket", BACKUP_KEEP: "2" },
      fetchImpl: storage.fetchImpl,
      now: new Date("2026-11-10T08:00:00.000Z")
    });

    expect(result.pruned).toBe(2);
    expect(storage.deleted).toEqual([
      "kpital-backup-2026-11-07T08-00-00-000Z.json.gz",
      "kpital-backup-2026-11-08T08-00-00-000Z.json.gz"
    ]);
    expect([...storage.objects.keys()].sort()).toEqual([
      "kpital-backup-2026-11-09T08-00-00-000Z.json.gz",
      "kpital-backup-2026-11-10T08-00-00-000Z.json.gz"
    ]);
  });

  it("deletes nothing when the upload fails", async () => {
    const storage = fakeStorage(["kpital-backup-2026-11-07T08-00-00-000Z.json.gz"]);
    const failing = vi.fn(async (input, init = {}) =>
      String(input).includes("/upload/") ? new Response("denied", { status: 403 }) : storage.fetchImpl(input, init)
    );

    await expect(
      runBackup({ env: { BACKUP_BUCKET: "bucket", BACKUP_KEEP: "1" }, fetchImpl: failing })
    ).rejects.toThrow(/HTTP 403/);
    expect(storage.deleted).toEqual([]);
  });
});

describe("POST /api/backup/cron/run", () => {
  it("rejects a missing or wrong cron secret", async () => {
    process.env.CRON_SECRET = "cron-secret";
    process.env.BACKUP_BUCKET = "bucket";
    await request(app).post("/api/backup/cron/run").expect(401);
    await request(app).post("/api/backup/cron/run").set("x-cron-secret", "nope").expect(401);
  });

  it("reports 503 when no bucket is configured", async () => {
    process.env.CRON_SECRET = "cron-secret";
    const res = await request(app).post("/api/backup/cron/run").set("x-cron-secret", "cron-secret");
    expect(res.status).toBe(503);
    expect(res.body.message).toBe("Backup is not configured.");
  });
});

describe("GET /api/backup", () => {
  it("exports every collection of the caller's account and nobody else's", async () => {
    await RecurringEntry.collection.insertOne({ accountId: accountA, description: "Rent" });
    await TaxRemittance.collection.insertMany([
      { accountId: accountA, year: 2026, quarter: 1, amount: 10 },
      { accountId: accountB, year: 2026, quarter: 1, amount: 99 }
    ]);

    const res = await request(app)
      .get("/api/backup")
      .set("Authorization", `Bearer ${tokenFor(accountA)}`)
      .expect(200);

    expect(res.body.counts).toMatchObject({
      entries: 1,
      recurringEntries: 1,
      taxRemittances: 1,
      smsMessages: 0,
      smsOptOuts: 0
    });
    expect(res.body.entries[0].income).toBe(100);
    expect(res.body.taxRemittances[0].amount).toBe(10);
  });
});

describe("restoring a backup", () => {
  const snapshot = async () =>
    (await mongoose.connection.collection("entries").find({}).sort({ income: 1 }).toArray()).map((doc) => ({
      id: String(doc._id),
      account: String(doc.accountId),
      date: doc.date.toISOString(),
      income: doc.income
    }));

  it("brings every record back as it was, ids and dates included", async () => {
    const before = await snapshot();
    const { gzipped, counts } = await dumpDatabase();
    expect(readDump(gzipped).counts).toEqual(counts);

    await mongoose.connection.collection("entries").deleteMany({});
    const result = await restoreDump(mongoose.connection.db, gzipped);
    expect(result.restored.entries).toBe(2);
    expect(await snapshot()).toEqual(before);
    const [doc] = await mongoose.connection.collection("entries").find({}).toArray();
    expect(doc._id).toBeInstanceOf(mongoose.mongo.ObjectId);
    expect(doc.date).toBeInstanceOf(Date);
  });

  it("refuses a database that already has records, unless told to replace them", async () => {
    const { gzipped } = await dumpDatabase();
    await mongoose.connection.collection("entries").insertOne({ accountId: accountA, date: new Date("2026-04-01"), type: "Sales", income: 7 });

    await expect(restoreDump(mongoose.connection.db, gzipped)).rejects.toThrow(/already has records in "entries"/);
    expect(await mongoose.connection.collection("entries").countDocuments()).toBe(3);

    await restoreDump(mongoose.connection.db, gzipped, { replace: true });
    expect((await snapshot()).map((doc) => doc.income)).toEqual([50, 100]);
  });

  it("rejects a file that is not a backup", async () => {
    const { gzipSync } = await import("node:zlib");
    expect(() => readDump(gzipSync(JSON.stringify({ hello: "world" })))).toThrow("not a Kpital OS backup");
  });
});
