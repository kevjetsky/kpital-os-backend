import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

const sentEmails = [];
vi.mock("../services/emailService.js", () => ({
  sendVerificationEmail: vi.fn(async (to, code) => {
    sentEmails.push({ to, code, purpose: "email" });
  }),
  sendPasswordResetEmail: vi.fn(async (to, code) => {
    sentEmails.push({ to, code, purpose: "reset" });
  })
}));

const { default: app } = await import("../app.js");

let mongod;

const EMAIL = "owner@example.com";

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  sentEmails.length = 0;
});

function lastCode() {
  return sentEmails[sentEmails.length - 1]?.code;
}

async function setupVerifiedAccount(password = "mypassword") {
  await request(app).post("/api/auth/setup").send({ email: EMAIL, password });
  const res = await request(app)
    .post("/api/auth/verify-email")
    .send({ email: EMAIL, code: lastCode() });
  return res.body.token;
}

describe("GET /api/auth/status", () => {
  it("returns requiresSetup: true when no settings exist", async () => {
    const res = await request(app).get("/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body.requiresSetup).toBe(true);
    expect(res.body.legacy).toBe(false);
    expect(res.body.authenticated).toBe(false);
  });

  it("flags legacy accounts without an email as requiring setup", async () => {
    const { Settings } = await import("../models/Settings.js");
    await Settings.create({ key: "main", passwordHash: "legacy-hash" });

    const res = await request(app).get("/api/auth/status");
    expect(res.body.requiresSetup).toBe(true);
    expect(res.body.legacy).toBe(true);
  });

  it("allows Cloudflare Pages preview origins", async () => {
    const res = await request(app)
      .options("/api/auth/status")
      .set("Origin", "https://d146fa62.kpital-os.pages.dev")
      .set("Access-Control-Request-Method", "GET");

    expect(res.status).toBe(204);
    expect(res.headers["access-control-allow-origin"]).toBe("https://d146fa62.kpital-os.pages.dev");
  });
});

describe("POST /api/auth/setup", () => {
  it("creates the account and emails a verification code without issuing a token", async () => {
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: EMAIL, password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.requiresVerification).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0].to).toBe(EMAIL);
    expect(sentEmails[0].code).toMatch(/^\d{6}$/);
  });

  it("rejects missing email", async () => {
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "password123" });
    expect(res.status).toBe(400);
  });

  it("rejects password shorter than 4 chars", async () => {
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: EMAIL, password: "abc" });
    expect(res.status).toBe(400);
  });

  it("resends a code when an unverified account retries with the same credentials", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    const res = await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    expect(res.status).toBe(200);
    expect(res.body.requiresVerification).toBe(true);
    expect(sentEmails).toHaveLength(2);
  });

  it("rejects setup once the account is verified", async () => {
    await setupVerifiedAccount("password123");
    const res = await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password456" });
    expect(res.status).toBe(409);
  });

  it("attaches an email to a legacy account only with the correct existing password", async () => {
    const { Settings } = await import("../models/Settings.js");
    const bcrypt = (await import("bcryptjs")).default;
    await Settings.create({ key: "main", passwordHash: await bcrypt.hash("legacypass", 10) });

    const denied = await request(app)
      .post("/api/auth/setup")
      .send({ email: EMAIL, password: "wrongpass" });
    expect(denied.status).toBe(401);

    const res = await request(app)
      .post("/api/auth/setup")
      .send({ email: EMAIL, password: "legacypass" });
    expect(res.status).toBe(200);
    expect(res.body.requiresVerification).toBe(true);
    expect(sentEmails).toHaveLength(1);
  });
});

describe("POST /api/auth/verify-email", () => {
  it("verifies the code and returns a token", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ email: EMAIL, code: lastCode() });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("rejects a wrong code", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    const wrongCode = lastCode() === "000000" ? "111111" : "000000";
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ email: EMAIL, code: wrongCode });
    expect(res.status).toBe(401);
  });

  it("locks out after too many wrong attempts", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    const correct = lastCode();
    const wrongCode = correct === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      await request(app).post("/api/auth/verify-email").send({ email: EMAIL, code: wrongCode });
    }
    const res = await request(app)
      .post("/api/auth/verify-email")
      .send({ email: EMAIL, code: correct });
    expect(res.status).toBe(429);
  });
});

describe("POST /api/auth/resend-code", () => {
  it("sends a fresh code for an unverified account", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    const res = await request(app).post("/api/auth/resend-code").send({ email: EMAIL });
    expect(res.status).toBe(200);
    expect(sentEmails).toHaveLength(2);
  });

  it("rejects resend for an already-verified account", async () => {
    await setupVerifiedAccount("password123");
    const res = await request(app).post("/api/auth/resend-code").send({ email: EMAIL });
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("returns token with correct email and password", async () => {
    await setupVerifiedAccount("mypassword");
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "mypassword" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("uses only an HttpOnly cookie for browser-origin logins", async () => {
    await setupVerifiedAccount("mypassword");
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "http://localhost:3000")
      .send({ email: EMAIL, password: "mypassword" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
    expect(res.headers["set-cookie"]?.[0]).toContain("HttpOnly");
  });

  it("rejects unsafe requests from an untrusted browser origin", async () => {
    const res = await request(app)
      .post("/api/auth/login")
      .set("Origin", "https://attacker.example")
      .send({ email: EMAIL, password: "mypassword" });
    expect(res.status).toBe(403);
  });

  it("is case-insensitive on email", async () => {
    await setupVerifiedAccount("mypassword");
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "Owner@Example.COM", password: "mypassword" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("rejects wrong password", async () => {
    await setupVerifiedAccount("mypassword");
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "wrong" });
    expect(res.status).toBe(401);
  });

  it("rejects wrong email", async () => {
    await setupVerifiedAccount("mypassword");
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: "other@example.com", password: "mypassword" });
    expect(res.status).toBe(401);
  });

  it("re-sends a verification code instead of a token when email is unverified", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "mypassword" });
    const res = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "mypassword" });
    expect(res.status).toBe(200);
    expect(res.body.requiresVerification).toBe(true);
    expect(res.body.token).toBeUndefined();
    expect(sentEmails).toHaveLength(2);
  });
});

describe("POST /api/auth/forgot-password + reset-password", () => {
  it("resets the password with the emailed code and returns a token", async () => {
    await setupVerifiedAccount("oldpassword");
    const forgot = await request(app).post("/api/auth/forgot-password").send({ email: EMAIL });
    expect(forgot.status).toBe(200);

    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: EMAIL, code: lastCode(), newPassword: "newpassword" });
    expect(reset.status).toBe(200);
    expect(reset.body.token).toBeTruthy();

    const oldLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "oldpassword" });
    expect(oldLogin.status).toBe(401);

    const newLogin = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "newpassword" });
    expect(newLogin.status).toBe(200);
    expect(newLogin.body.token).toBeTruthy();
  });

  it("rejects a wrong reset code without changing the password", async () => {
    await setupVerifiedAccount("oldpassword");
    await request(app).post("/api/auth/forgot-password").send({ email: EMAIL });
    const wrongCode = lastCode() === "000000" ? "111111" : "000000";

    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: EMAIL, code: wrongCode, newPassword: "newpassword" });
    expect(reset.status).toBe(401);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "oldpassword" });
    expect(login.status).toBe(200);
  });

  it("does not reveal whether a forgot-password email exists", async () => {
    await setupVerifiedAccount("oldpassword");
    const res = await request(app)
      .post("/api/auth/forgot-password")
      .send({ email: "other@example.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, requiresReset: true });
  });

  it("does not accept an email-verification code for a password reset", async () => {
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    const verificationCode = lastCode();

    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: EMAIL, code: verificationCode, newPassword: "newpassword" });
    expect(reset.status).toBe(410);
  });

  it("marks the email verified after a successful reset", async () => {
    // Legacy-attached account that never finished verification.
    await request(app).post("/api/auth/setup").send({ email: EMAIL, password: "password123" });
    await request(app).post("/api/auth/forgot-password").send({ email: EMAIL });
    const reset = await request(app)
      .post("/api/auth/reset-password")
      .send({ email: EMAIL, code: lastCode(), newPassword: "newpassword" });
    expect(reset.status).toBe(200);

    const login = await request(app)
      .post("/api/auth/login")
      .send({ email: EMAIL, password: "newpassword" });
    expect(login.status).toBe(200);
    expect(login.body.token).toBeTruthy();
  });
});

describe("GET /api/entries", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/entries");
    expect(res.status).toBe(401);
  });

  it("returns entries array for authenticated user", async () => {
    const token = await setupVerifiedAccount("mypassword");
    const res = await request(app)
      .get("/api/entries")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("filters entries by search text", async () => {
    const token = await setupVerifiedAccount("mypassword");

    await request(app)
      .post("/api/entries")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "Repair",
        date: "2026-05-12",
        description: "HDMI port repair",
        income: 120,
        customerName: "Avery Console",
        customerPhone: "555-010-1111"
      });
    await request(app)
      .post("/api/entries")
      .set("Authorization", `Bearer ${token}`)
      .send({
        type: "Sales",
        date: "2026-05-12",
        description: "Controller sale",
        income: 45,
        customerName: "Morgan Retail",
        customerInstagram: "@morgan.retail"
      });

    const res = await request(app)
      .get("/api/entries?search=avery")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0].customerName).toBe("Avery Console");
  });
});
