// Account creation (phase 2): invite-gated signup, per-email login, and proof
// that a brand-new account starts empty and cannot see the first account's data.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";

let mongod;
let passwordHash;

const INVITE = "test-invite-code";

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  process.env.SIGNUP_INVITE_CODE = INVITE;
  // app.js pulls in dotenv/config, so the real .env — including a live Resend
  // key — is loaded here. Clear it so tests never send actual email.
  delete process.env.RESEND_API_KEY;
  await mongoose.connect(mongod.getUri());
  passwordHash = await bcrypt.hash("password123", 10);
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  process.env.SIGNUP_INVITE_CODE = INVITE;
  // The pre-existing business.
  await Settings.create({
    key: "main",
    email: "owner@example.com",
    emailVerified: true,
    passwordHash,
  });
  // Rate limiters are per-process; ensure the index the unique email relies on
  // exists for this fresh database.
  await Settings.syncIndexes();
});

const signup = (body) => request(app).post("/api/auth/signup").send(body);

describe("account signup", () => {
  it("rejects signup without the invite code", async () => {
    const res = await signup({ email: "new@example.com", password: "password123" });
    expect(res.status).toBe(400); // schema requires inviteCode
  });

  it("rejects a wrong invite code", async () => {
    const res = await signup({
      email: "new@example.com",
      password: "password123",
      inviteCode: "wrong-code",
    });
    expect(res.status).toBe(403);
    expect(await Settings.countDocuments({})).toBe(1);
  });

  it("refuses to create accounts when no invite code is configured", async () => {
    delete process.env.SIGNUP_INVITE_CODE;
    const res = await signup({
      email: "new@example.com",
      password: "password123",
      inviteCode: "anything",
    });
    // Closed by default: a missing env var must not mean open registration.
    expect(res.status).toBe(403);
    expect(await Settings.countDocuments({})).toBe(1);
  });

  it("creates a second account with a valid invite code", async () => {
    const res = await signup({
      email: "second@example.com",
      password: "password123",
      inviteCode: INVITE,
    });
    expect(res.status).toBe(201);
    expect(res.body.requiresVerification).toBe(true);
    expect(await Settings.countDocuments({})).toBe(2);
  });

  it("rejects a duplicate email", async () => {
    const res = await signup({
      email: "owner@example.com",
      password: "password123",
      inviteCode: INVITE,
    });
    expect(res.status).toBe(409);
    expect(await Settings.countDocuments({})).toBe(1);
  });

  it("treats emails case-insensitively so one address is one account", async () => {
    const res = await signup({
      email: "OWNER@Example.com",
      password: "password123",
      inviteCode: INVITE,
    });
    expect(res.status).toBe(409);
  });
});

describe("multi-account login", () => {
  beforeEach(async () => {
    await Settings.create({
      email: "second@example.com",
      emailVerified: true,
      passwordHash,
    });
  });

  it("logs each account in against its own email", async () => {
    const a = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "password123" });
    const b = await request(app)
      .post("/api/auth/login")
      .send({ email: "second@example.com", password: "password123" });

    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.token).toBeTruthy();
    expect(b.body.token).toBeTruthy();
    // Different accounts must not be handed the same session.
    expect(a.body.token).not.toBe(b.body.token);
  });

  it("rejects an email that has no account", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "nobody@example.com", password: "password123" });
    expect(res.status).toBe(401);
    expect(res.body.message).toBe("Invalid email or password.");
  });

  it("does not let one account's password unlock another", async () => {
    const other = await bcrypt.hash("different-password", 10);
    await Settings.findOneAndUpdate({ email: "second@example.com" }, { passwordHash: other });

    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "second@example.com", password: "password123" });
    expect(res.status).toBe(401);
  });

  it("gives a new account an empty ledger, not the first account's data", async () => {
    const a = await request(app)
      .post("/api/auth/login")
      .send({ email: "owner@example.com", password: "password123" });
    const b = await request(app)
      .post("/api/auth/login")
      .send({ email: "second@example.com", password: "password123" });

    const created = await request(app)
      .post("/api/entries")
      .set("Authorization", `Bearer ${a.body.token}`)
      .send({
        type: "Repair",
        date: "2026-06-01",
        description: "Account A job",
        income: 120,
        customerPhone: "555-0101",
      });
    expect(created.status).toBe(201);

    const listB = await request(app)
      .get("/api/entries")
      .set("Authorization", `Bearer ${b.body.token}`);
    expect(listB.status).toBe(200);
    expect(listB.body).toHaveLength(0);

    const listA = await request(app)
      .get("/api/entries")
      .set("Authorization", `Bearer ${a.body.token}`);
    expect(listA.body).toHaveLength(1);
  });
});
