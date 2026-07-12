import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app.js";

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
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
});

describe("GET /api/auth/status", () => {
  it("returns requiresSetup: true when no settings exist", async () => {
    const res = await request(app).get("/api/auth/status");
    expect(res.status).toBe(200);
    expect(res.body.requiresSetup).toBe(true);
    expect(res.body.authenticated).toBe(false);
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
  it("creates password and returns token", async () => {
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "password123" });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.token).toBeTruthy();
  });

  it("rejects password shorter than 4 chars", async () => {
    const res = await request(app)
      .post("/api/auth/setup")
      .send({ password: "abc" });
    expect(res.status).toBe(400);
  });

  it("rejects second setup attempt", async () => {
    await request(app).post("/api/auth/setup").send({ password: "password123" });
    const res = await request(app).post("/api/auth/setup").send({ password: "password456" });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/auth/login", () => {
  it("returns token with correct password", async () => {
    await request(app).post("/api/auth/setup").send({ password: "mypassword" });
    const res = await request(app).post("/api/auth/login").send({ password: "mypassword" });
    expect(res.status).toBe(200);
    expect(res.body.token).toBeTruthy();
  });

  it("rejects wrong password", async () => {
    await request(app).post("/api/auth/setup").send({ password: "mypassword" });
    const res = await request(app).post("/api/auth/login").send({ password: "wrong" });
    expect(res.status).toBe(401);
  });
});

describe("GET /api/entries", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/entries");
    expect(res.status).toBe(401);
  });

  it("returns entries array for authenticated user", async () => {
    await request(app).post("/api/auth/setup").send({ password: "mypassword" });
    const loginRes = await request(app).post("/api/auth/login").send({ password: "mypassword" });
    const token = loginRes.body.token;
    const res = await request(app)
      .get("/api/entries")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("filters entries by search text", async () => {
    await request(app).post("/api/auth/setup").send({ password: "mypassword" });
    const loginRes = await request(app).post("/api/auth/login").send({ password: "mypassword" });
    const token = loginRes.body.token;

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
