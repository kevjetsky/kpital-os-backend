// Customer details (a search for a name or phone, an Instagram handle, a
// serial, an address) can be sent in a POST body instead of the URL, so they
// stay out of Google's request log. Each POST must answer exactly as its GET.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { queryFromBody } from "../middleware/queryFromBody.js";
import { clearGeoCache } from "../services/geoService.js";

let mongod;
let token;
let passwordHash;

beforeAll(async () => {
  mongod = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());
  passwordHash = await bcrypt.hash("password123", 10);
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
  await Settings.create({ key: "main", email: "owner@example.com", emailVerified: true, passwordHash });
  const login = await request(app).post("/api/auth/login").send({ email: "owner@example.com", password: "password123" });
  token = login.body.token;
  clearGeoCache();
  process.env.GEO_LOOKUP = "off";
});

afterEach(() => {
  vi.unstubAllGlobals();
  process.env.GEO_LOOKUP = "off";
});

const authed = (req) => req.set("Authorization", `Bearer ${token}`);

async function createRepair(overrides = {}) {
  const res = await authed(request(app).post("/api/entries")).send({
    type: "Repair",
    date: "2026-06-01",
    description: "HDMI port replacement",
    income: 100,
    customerName: "Maria Lopez",
    customerPhone: "555-0101",
    ...overrides
  });
  expect(res.status).toBe(201);
  return res.body;
}

const ids = (list) => list.map((item) => String(item._id));

describe("queryFromBody", () => {
  const run = (body, query = {}) => {
    const req = { body, query };
    queryFromBody(req, {}, () => {});
    return req.query;
  };

  it("reads the body as a query string would carry it", () => {
    expect(run({ search: "Maria", page: 2, b2b: true, tags: ["a", 3] })).toEqual({
      search: "Maria",
      page: "2",
      b2b: "true",
      tags: ["a", "3"]
    });
  });

  it("drops nested objects and empty values, and keeps what the URL had", () => {
    expect(run({ search: { $ne: "" }, phone: null, zip: undefined, kind: "jobs" }, { limit: "5" })).toEqual({
      limit: "5",
      kind: "jobs"
    });
    expect(run(undefined, { limit: "5" })).toEqual({ limit: "5" });
    expect(run(["search"], {})).toEqual({});
  });
});

describe("searches sent in the body", () => {
  it("needs a signed-in owner", async () => {
    for (const path of ["/api/entries/query", "/api/entries/warranty-candidates", "/api/entries/refund-candidates", "/api/inventory/query", "/api/geo/resolve", "/api/geo/autocomplete"]) {
      expect((await request(app).post(path).send({})).status).toBe(401);
    }
  });

  it("searches entries like the URL form, paging included", async () => {
    const maria = await createRepair();
    await createRepair({ customerName: "John Smith", customerPhone: "555-0202", description: "Disc drive swap" });

    const viaUrl = await authed(request(app).get("/api/entries").query({ search: "maria", page: 1, limit: 10 }));
    const viaBody = await authed(request(app).post("/api/entries/query")).send({ search: "maria", page: 1, limit: 10 });
    expect(viaBody.status).toBe(200);
    expect(viaBody.body).toEqual(viaUrl.body);
    expect(ids(viaBody.body.items)).toEqual([String(maria._id)]);
  });

  it("finds warranty candidates by phone", async () => {
    const original = await createRepair();
    const body = { phone: "555-0101", date: "2026-06-20" };

    const viaUrl = await authed(request(app).get("/api/entries/warranty-candidates").query(body));
    const viaBody = await authed(request(app).post("/api/entries/warranty-candidates")).send(body);
    expect(viaBody.status).toBe(200);
    expect(viaBody.body).toEqual(viaUrl.body);
    expect(ids(viaBody.body.candidates)).toEqual([String(original._id)]);
  });

  it("finds refund candidates by phone and rejects a bad limit the same way", async () => {
    await createRepair();
    const other = await createRepair({ customerName: "John Smith", customerPhone: "555-0202" });

    const viaBody = await authed(request(app).post("/api/entries/refund-candidates")).send({ phone: "555-0202" });
    expect(viaBody.status).toBe(200);
    expect(ids(viaBody.body.candidates)).toEqual([String(other._id)]);

    const bad = await authed(request(app).post("/api/entries/refund-candidates")).send({ limit: 0 });
    expect(bad.status).toBe(400);
  });

  it("searches inventory by typed text", async () => {
    for (const [name, sku] of [["DualSense stick module", "DS-STICK"], ["HDMI Port", "HDMI-V21"]]) {
      await authed(request(app).post("/api/inventory")).send({ name, sku, category: "Parts", quantity: 3, costPerUnit: 4 });
    }
    const res = await authed(request(app).post("/api/inventory/query")).send({ search: "hdmi" });
    expect(res.status).toBe(200);
    expect(res.body.map((item) => item.sku)).toEqual(["HDMI-V21"]);
  });

  it("looks up an address from the body, sending it on to the lookup service", async () => {
    const calls = [];
    process.env.GEO_LOOKUP = "on";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url) => {
        calls.push(decodeURIComponent(String(url).replace(/\+/g, " ")));
        return {
          ok: true,
          json: async () => ({
            result: {
              addressMatches: [
                {
                  matchedAddress: "9800 BISSONNET ST, HOUSTON, TX, 77036",
                  coordinates: { x: -95.55023, y: 29.6754 },
                  addressComponents: { city: "HOUSTON", state: "TX", zip: "77036" }
                }
              ]
            }
          })
        };
      })
    );

    const res = await authed(request(app).post("/api/geo/resolve")).send({ address: "9800 bissonnet st, houston" });
    expect(res.status).toBe(200);
    expect(res.body.match).toMatchObject({ zip: "77036", lat: 29.6754 });
    expect(calls.some((href) => href.includes("9800 bissonnet st"))).toBe(true);

    const suggest = await authed(request(app).post("/api/geo/autocomplete")).send({ q: "9800 bissonnet" });
    expect(suggest.status).toBe(200);
    expect(Array.isArray(suggest.body.suggestions)).toBe(true);
  });
});
