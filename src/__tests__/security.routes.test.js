// Who a request comes from behind App Engine, and ending sessions.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import mongoose from "mongoose";
import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { trustAppEngineProxy } from "../middleware/clientIp.js";
import { clearSessionEpochs } from "../middleware/auth.js";
import { Settings } from "../models/Settings.js";

const sentCodes = [];
vi.mock("../services/emailService.js", () => ({
  sendVerificationEmail: vi.fn(async (_to, code) => sentCodes.push(code)),
  sendPasswordResetEmail: vi.fn(async (_to, code) => sentCodes.push(code))
}));
const { default: app, loggedUrl } = await import("../app.js");
const { secretsMatch } = await import("../middleware/sharedSecret.js");

describe("what reaches the logs and how secrets are compared", () => {
  it("keeps query parameter names in the access log, never their values", () => {
    expect(loggedUrl("/api/geo/autocomplete?q=123%20Main%20St")).toBe("/api/geo/autocomplete?q=…");
    expect(loggedUrl("/api/entries?search=Maria&page=2")).toBe("/api/entries?search=…&page=…");
    expect(loggedUrl("/api/entries/summary")).toBe("/api/entries/summary");
    expect(loggedUrl("/api/health?")).toBe("/api/health");
  });

  it("compares shared secrets whatever their length", () => {
    expect(secretsMatch("s3cret", "s3cret")).toBe(true);
    expect(secretsMatch("s3cre", "s3cret")).toBe(false);
    expect(secretsMatch("", "s3cret")).toBe(false);
  });
});

describe("the client address behind App Engine", () => {
  const echo = express();
  echo.set("trust proxy", trustAppEngineProxy);
  echo.get("/ip", (req, res) => res.json({ ip: req.ip }));
  const ipFor = async (forwardedFor) => {
    const req = request(echo).get("/ip");
    if (forwardedFor) req.set("X-Forwarded-For", forwardedFor);
    return (await req).body.ip;
  };

  it("is the address Google's load balancer saw, not anything the client wrote before it", async () => {
    // Google appends "CLIENT_IP, FORWARDING_RULE_IP".
    expect(await ipFor("203.0.113.7, 34.111.1.1")).toBe("203.0.113.7");
    // A client writing its own header cannot choose its address.
    expect(await ipFor("1.2.3.4, 203.0.113.7, 34.111.1.1")).toBe("203.0.113.7");
    expect(await ipFor("1.2.3.4, 5.6.7.8, 203.0.113.7, 34.111.1.1")).toBe("203.0.113.7");
  });

  it("is the socket itself when nothing is forwarded, or the socket is not the local proxy", async () => {
    expect(await ipFor("")).toMatch(/127\.0\.0\.1|::1/);
    expect(trustAppEngineProxy("10.0.0.5", 0)).toBe(false);
    expect(trustAppEngineProxy("127.0.0.1", 0)).toBe(true);
    expect(trustAppEngineProxy("34.111.1.1", 1)).toBe(true);
    expect(trustAppEngineProxy("203.0.113.7", 2)).toBe(false);
  });
});

describe("ending sessions", () => {
  let mongod;
  let account;

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
    await mongoose.connection.dropDatabase();
    clearSessionEpochs();
    sentCodes.length = 0;
    account = await Settings.create({ email: "owner@example.com", emailVerified: true, passwordHash: await bcrypt.hash("password123", 10) });
  });

  const login = async () =>
    (await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" })).body.token;
  const works = async (token) => (await request(app).get("/api/entries/summary").set("Authorization", `Bearer ${token}`)).status;

  it("a new password signs out every other session, and keeps the one that reset it", async () => {
    const phone = await login();
    const mcp = jwt.sign({ role: "owner", accountId: String(account._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
    expect(await works(phone)).toBe(200);
    expect(await works(mcp)).toBe(200);

    await request(app).post("/api/auth/forgot-password").send({ email: "owner@example.com" });
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: "owner@example.com", code: sentCodes.at(-1), newPassword: "brand-new-pass-1" });
    expect(reset.status).toBe(200);

    const stale = await request(app).get("/api/entries/summary").set("Authorization", `Bearer ${phone}`);
    expect(stale.status).toBe(401);
    expect(stale.body.message).toBe("This session was signed out. Please sign in again.");
    expect(await works(mcp)).toBe(401);
    expect(await works(reset.body.token)).toBe(200);
    expect((await request(app).get("/api/auth/status").set("Authorization", `Bearer ${phone}`)).body.authenticated).toBe(false);
  });

  it("sign out everywhere ends every session, this one included", async () => {
    const one = await login();
    const two = await login();
    const out = await request(app).post("/api/auth/logout-all").set("Authorization", `Bearer ${one}`);
    expect(out.status).toBe(200);
    expect(await works(one)).toBe(401);
    expect(await works(two)).toBe(401);
    expect(await works(await login())).toBe(200);
  });

  it("a token for an account that no longer exists does nothing", async () => {
    const token = await login();
    await Settings.deleteOne({ _id: account._id });
    clearSessionEpochs();
    expect(await works(token)).toBe(401);
  });
});
