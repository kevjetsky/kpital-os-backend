// The dashboard's opening request is GET /api/entries with no pagination, which
// returns the account's whole entry history. Over cellular that payload is the
// single biggest cost of a page load, so it must go out gzipped.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";

let mongod;
let token;
let accountId;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());

  const account = await Settings.create({
    key: "main",
    email: "compression@test.com",
    passwordHash: await bcrypt.hash("password123", 10),
    emailVerified: true,
  });
  accountId = account._id;
  token = jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, {
    expiresIn: "1h",
  });

  // Comfortably past compression's 1kb threshold.
  await Entry.insertMany(
    Array.from({ length: 40 }, (_, i) => ({
      accountId,
      date: new Date(2026, 0, (i % 28) + 1),
      type: "Repair",
      description: `Console repair job number ${i} with a description long enough to matter`,
      income: 100 + i,
      expense: 10,
      salesTax: 8.25,
      netProfit: 90 + i,
      customerName: `Customer ${i}`,
      status: "Paid",
    }))
  );
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

describe("response compression", () => {
  it("gzips the full entry list for clients that accept it", async () => {
    const res = await request(app)
      .get("/api/entries")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept-Encoding", "gzip");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBe("gzip");
    // supertest transparently decodes, so the body must still be intact.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(40);
  });

  it("serves an identity response when the client does not accept gzip", async () => {
    const res = await request(app)
      .get("/api/entries")
      .set("Authorization", `Bearer ${token}`)
      .set("Accept-Encoding", "identity");

    expect(res.status).toBe(200);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.body).toHaveLength(40);
  });
});
