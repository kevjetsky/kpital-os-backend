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
});
