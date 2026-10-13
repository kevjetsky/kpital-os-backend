import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import bcrypt from "bcryptjs";
import app from "../app.js";
import { Settings } from "../models/Settings.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { clearGeoCache, parseAddressText, titleCaseAddress } from "../services/geoService.js";

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
const postEntry = (body) => authed(request(app).post("/api/entries")).send(body);
const putEntry = (id, body) => authed(request(app).put(`/api/entries/${id}`)).send(body);

const photonFeature = (properties, [lng, lat] = [-95.5697, 29.7088]) => ({
  type: "Feature",
  geometry: { type: "Point", coordinates: [lng, lat] },
  properties: { countrycode: "US", state: "Texas", county: "Harris", ...properties }
});

const censusMatch = (matchedAddress, city, zip, [lng, lat]) => ({
  result: { addressMatches: [{ matchedAddress, coordinates: { x: lng, y: lat }, addressComponents: { city, state: "TX", zip } }] }
});

// Stands in for both public services. `calls` records every URL asked for.
function stubLookups({ photon = { features: [] }, census = { result: { addressMatches: [] } }, reverse = { features: [] } } = {}) {
  const calls = [];
  process.env.GEO_LOOKUP = "on";
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url) => {
      const href = String(url);
      calls.push(href);
      const body = href.includes("census.gov") ? census : href.includes("/reverse") ? reverse : photon;
      if (body instanceof Error) throw body;
      return { ok: true, json: async () => body };
    })
  );
  return calls;
}

describe("address lookup", () => {
  it("needs a signed-in owner", async () => {
    expect((await request(app).get("/api/geo/autocomplete?q=bandlon")).status).toBe(401);
    expect((await request(app).get("/api/geo/resolve?address=x")).status).toBe(401);
  });

  it("suggests streets with the number that was typed, one line per street and city", async () => {
    const calls = stubLookups({
      photon: {
        features: [
          photonFeature({ type: "street", name: "Bissonnet Street", city: "Houston", postcode: "77401" }),
          // Another stretch of the same road, in another ZIP code.
          photonFeature({ type: "street", name: "Bissonnet Street", city: "Houston", postcode: "77036" }),
          photonFeature({ type: "street", name: "Bissonnet Street", city: "Bellaire", postcode: "77401" }),
          photonFeature({ type: "house", housenumber: "9800", street: "Bissonnet Road", city: "Houston", postcode: "77036", district: "Sharpstown" }),
          // A park with no street is not somewhere a job happens.
          photonFeature({ type: "other", name: "Bissonnet Park", city: "Houston" }),
          photonFeature({ type: "street", name: "Bissonnet Strasse", city: "Berlin", countrycode: "DE" })
        ]
      }
    });

    const res = await authed(request(app).get("/api/geo/autocomplete?q=9800%20Bissonnet"));
    expect(res.status).toBe(200);
    expect(res.body.suggestions.map((s) => s.label)).toEqual([
      "9800 Bissonnet Street, Houston, TX",
      "9800 Bissonnet Street, Bellaire, TX",
      "9800 Bissonnet Road, Houston, TX 77036"
    ]);
    // A street match could be in any ZIP the road crosses, so it claims none.
    expect(res.body.suggestions[0].zip).toBe("");
    expect(res.body.suggestions[2]).toMatchObject({ zip: "77036", neighborhood: "Sharpstown", lat: 29.7088 });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("photon.komoot.io/api");

    // The same text again is answered from memory.
    await authed(request(app).get("/api/geo/autocomplete?q=9800%20bissonnet"));
    expect(calls).toHaveLength(1);
  });

  it("asks nothing for a few letters, and returns nothing when the service is down or switched off", async () => {
    const calls = stubLookups({ photon: new Error("down") });
    expect((await authed(request(app).get("/api/geo/autocomplete?q=ban"))).body.suggestions).toEqual([]);
    expect(calls).toHaveLength(0);
    expect((await authed(request(app).get("/api/geo/autocomplete?q=bandlon"))).body.suggestions).toEqual([]);
    expect(calls).toHaveLength(1);

    process.env.GEO_LOOKUP = "off";
    expect((await authed(request(app).get("/api/geo/autocomplete?q=bandlon%20drive"))).body.suggestions).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("resolves a full address to its exact ZIP code, coordinates and neighborhood", async () => {
    stubLookups({
      census: censusMatch("9800 BISSONNET ST, HOUSTON, TX, 77036", "HOUSTON", "77036", [-95.55023, 29.6754]),
      reverse: { features: [photonFeature({ city: "Houston", district: "Sharpstown" })] }
    });

    const res = await authed(request(app).get("/api/geo/resolve?address=9800%20bissonnet%20st%20apt%204%20houston"));
    expect(res.body.match).toEqual({
      address: "9800 Bissonnet St, Houston, TX 77036",
      city: "Houston",
      state: "TX",
      zip: "77036",
      neighborhood: "Sharpstown",
      lat: 29.6754,
      lng: -95.55023
    });
  });

  it("returns no match for an address that cannot be placed", async () => {
    const calls = stubLookups();
    expect((await authed(request(app).get("/api/geo/resolve?address=123%20Nowhere%20Rd%2C%20Houston"))).body.match).toBeNull();
    // Too little to be an address: not even asked.
    expect((await authed(request(app).get("/api/geo/resolve?address=bandlon"))).body.match).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("reads city and ZIP out of address text, and writes street names the way people do", () => {
    expect(parseAddressText("9800 Bissonnet St, Houston, TX 77036")).toEqual({ city: "Houston", state: "TX", zip: "77036" });
    expect(parseAddressText("123 Main St Apt 4, Sugar Land, tx 77479-1234")).toEqual({ city: "Sugar Land", state: "TX", zip: "77479" });
    expect(parseAddressText("11822 Bandlon Dr Houston 77072")).toEqual({ city: "", state: "", zip: "77072" });
    // A five-digit house number is not a ZIP code.
    expect(parseAddressText("11822 Bandlon Dr")).toEqual({ city: "", state: "", zip: "" });
    expect(titleCaseAddress("11822 BANDLON DR")).toBe("11822 Bandlon Dr");
    expect(titleCaseAddress("2400 W 18TH ST")).toBe("2400 W 18th St");
    expect(titleCaseAddress("15000 FM 529 RD")).toBe("15000 FM 529 Rd");
  });
});

describe("a record's area", () => {
  const repair = (overrides = {}) => ({
    type: "Repair",
    date: "2026-10-01",
    description: "HDMI port",
    income: 100,
    customerPhone: "555-0101",
    ...overrides
  });
  const located = {
    customerAddress: "9800 Bissonnet St, Houston, TX 77036",
    addressZip: "77036",
    addressCity: "Houston",
    addressState: "TX",
    addressNeighborhood: "Sharpstown",
    addressLat: 29.6754,
    addressLng: -95.55023
  };

  it("stores what the form looked up, and keeps it through edits that leave the address alone", async () => {
    const created = await postEntry(repair(located));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject(located);

    const edited = await putEntry(created.body._id, { status: "Paid", paymentMethod: "Cash" });
    expect(edited.body).toMatchObject(located);

    // A different address without lookup data falls back to what the text says.
    const moved = await putEntry(created.body._id, { customerAddress: "100 Main St, Katy, TX 77494" });
    expect(moved.body).toMatchObject({ addressZip: "77494", addressCity: "Katy", addressNeighborhood: "", addressLat: null });

    // Removing the address removes its area with it.
    const cleared = await putEntry(created.body._id, { customerAddress: "" });
    expect(cleared.body).toMatchObject({ customerAddress: "", addressZip: "", addressCity: "", addressLat: null });
  });

  it("ignores junk area data and blank lookups", async () => {
    const junk = await postEntry(repair({ ...located, addressZip: "7703", addressLat: 999, addressLng: "x" }));
    // Nothing usable was sent, so the text speaks for itself.
    expect(junk.body).toMatchObject({ addressZip: "77036", addressCity: "Houston", addressLat: null, addressLng: null });

    const none = await postEntry(repair({ customerPhone: "555-0102" }));
    expect(none.body).toMatchObject({ customerAddress: "", addressZip: "", addressCity: "", addressLat: null });
  });

  it("looks the address up itself when the request did not, as for a record made through the MCP", async () => {
    stubLookups({
      census: censusMatch("11822 BANDLON DR, HOUSTON, TX, 77072", "HOUSTON", "77072", [-95.58555, 29.71009]),
      reverse: { features: [photonFeature({ city: "Houston", locality: "Alief" })] }
    });

    const res = await postEntry(repair({ customerAddress: "11822 Bandlon Dr, Houston" }));
    expect(res.body).toMatchObject({
      customerAddress: "11822 Bandlon Dr, Houston",
      addressZip: "77072",
      addressCity: "Houston",
      addressNeighborhood: "Alief",
      addressLat: 29.71009
    });
  });

  it("remembers the address on the customer, so their next record has its area without retyping", async () => {
    await postEntry(repair({ customerPhone: "555-0199" }));
    await postEntry(repair({ ...located, customerPhone: "555-0199" }));
    const customer = await ReferenceOption.findOne({ kind: "customer" }).setOptions({ allowCrossAccount: true });
    expect(customer.address).toBe(located.customerAddress);

    const next = await postEntry(repair({ customerPhone: "555-0199" }));
    expect(next.body).toMatchObject({ customerAddress: located.customerAddress, addressZip: "77036", addressCity: "Houston" });
  });

  it("takes a B2B record's area from the business", async () => {
    const business = await authed(request(app).post("/api/reference-options")).send({
      kind: "business",
      name: "GameStop #4821",
      addressLine1: "100 Main St",
      city: "Houston",
      state: "TX",
      postalCode: "77002"
    });
    const res = await postEntry({ type: "Repair", date: "2026-10-01", description: "Sticks", income: 80, isB2B: true, businessOptionId: business.body._id });
    expect(res.body).toMatchObject({ customerAddress: "100 Main St, Houston, TX 77002", addressZip: "77002", addressCity: "Houston" });
  });

  it("filters records by ZIP code and totals jobs, revenue and customers by area", async () => {
    await postEntry(repair({ ...located, income: 100 }));
    await postEntry(repair({ ...located, income: 60, customerPhone: "555-0102", date: "2026-10-05" }));
    await postEntry(repair({ customerAddress: "100 Main St, Katy, TX 77494", income: 200, customerPhone: "555-0103" }));
    await postEntry({ type: "Refund", date: "2026-10-06", description: "Refund", expense: 20, customerPhone: "555-0102", ...located });
    await postEntry(repair({ income: 40, customerPhone: "555-0104" }));
    await postEntry({ type: "Expenses", date: "2026-10-02", description: "Solder", expense: 15 });
    await postEntry(repair({ ...located, income: 999, customerPhone: "555-0105", date: "2026-08-01" }));

    const inZip = await authed(request(app).get("/api/entries?zip=77036"));
    expect(inZip.body).toHaveLength(4);
    expect((await authed(request(app).get("/api/entries?zip=7703"))).status).toBe(400);

    const stats = await authed(request(app).get("/api/entries/area-stats?from=2026-10-01&to=2026-10-31"));
    expect(stats.status).toBe(200);
    expect(stats.body.areas.map((a) => a.zip)).toEqual(["77494", "77036"]);
    expect(stats.body.areas[0]).toMatchObject({ city: "Katy", jobs: 1, revenue: 200, avgTicket: 200, customers: 1 });
    expect(stats.body.areas[1]).toMatchObject({
      city: "Houston",
      neighborhood: "Sharpstown",
      jobs: 2,
      revenue: 140,
      avgTicket: 70,
      customers: 2
    });
    expect(stats.body.areas[1].share).toBeCloseTo(140 / 340, 3);
    expect(String(stats.body.areas[1].lastDate).slice(0, 10)).toBe("2026-10-05");
    expect(stats.body.totals).toMatchObject({ jobs: 4, revenue: 380 });
    expect(stats.body.noAddress).toEqual({ jobs: 1, revenue: 40 });

    const all = await authed(request(app).get("/api/entries/area-stats"));
    expect(all.body.areas[0]).toMatchObject({ zip: "77036", jobs: 3, revenue: 1139 });
    expect((await authed(request(app).get("/api/entries/area-stats?from=nope"))).status).toBe(400);
  });
});
