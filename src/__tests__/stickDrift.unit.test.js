import { describe, it, expect } from "vitest";
import { STICK_DRIFT_STATUSES, TRANSITIONS, canTransition, planTransition, StickDriftError } from "../stickDrift/statusMachine.js";
import { priceCents, receivingAddress, siteOrigin, stickDriftReadiness, US_STATES } from "../stickDrift/config.js";

const order = (status, returnTracking) => ({ status, returnTracking });
const tracking = { carrier: "USPS", number: "9400100000000000000000" };

describe("stick drift status rules", () => {
  it("allows exactly the documented transitions and nothing else", () => {
    const allowed = [
      ["label_created", "arrived"],
      ["arrived", "repaired"],
      ["repaired", "paid"],
      ["paid", "shipped_back"],
      ["shipped_back", "delivered"],
      ["label_created", "cancelled"],
      ["arrived", "cancelled"],
    ].map(([from, to]) => `${from}>${to}`);

    for (const from of STICK_DRIFT_STATUSES) {
      for (const to of STICK_DRIFT_STATUSES) {
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(allowed.includes(`${from}>${to}`));
      }
    }
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STICK_DRIFT_STATUSES].sort());
  });

  it("returns a history entry with from, to, at and a trimmed note", () => {
    const at = new Date("2026-10-02T12:00:00Z");
    expect(planTransition(order("label_created"), "arrived", { note: "  box dented ", at })).toEqual({
      from: "label_created",
      to: "arrived",
      at,
      note: "box dented",
    });
  });

  it("rejects skipping a step, going backwards and repeating a status", () => {
    for (const [from, to] of [["label_created", "repaired"], ["paid", "repaired"], ["arrived", "arrived"], ["repaired", "delivered"]]) {
      expect(() => planTransition(order(from), to)).toThrow(StickDriftError);
    }
    try {
      planTransition(order("label_created"), "paid");
    } catch (err) {
      expect(err.code).toBe("invalid_transition");
      expect(err.status).toBe(409);
    }
  });

  it("only cancels from label_created or arrived", () => {
    expect(planTransition(order("label_created"), "cancelled").to).toBe("cancelled");
    expect(planTransition(order("arrived"), "cancelled").to).toBe("cancelled");
    for (const from of ["repaired", "paid", "shipped_back", "delivered", "cancelled"]) {
      expect(() => planTransition(order(from, tracking), "cancelled")).toThrow(/Cannot move/);
    }
  });

  it("nothing leaves delivered or cancelled", () => {
    for (const to of STICK_DRIFT_STATUSES) {
      expect(() => planTransition(order("delivered", tracking), to)).toThrow(StickDriftError);
      expect(() => planTransition(order("cancelled", tracking), to)).toThrow(StickDriftError);
    }
  });

  it("requires return tracking before shipped_back", () => {
    expect(() => planTransition(order("paid"), "shipped_back")).toThrow(/tracking/i);
    expect(() => planTransition(order("paid", { carrier: "USPS", number: " " }), "shipped_back")).toThrow(/tracking/i);
    expect(() => planTransition(order("paid"), "shipped_back", { returnTracking: { carrier: "", number: "123" } })).toThrow(/tracking/i);
    expect(planTransition(order("paid", tracking), "shipped_back").to).toBe("shipped_back");
    expect(planTransition(order("paid"), "shipped_back", { returnTracking: tracking }).to).toBe("shipped_back");
  });

  it("rejects an unknown status", () => {
    expect(() => planTransition(order("arrived"), "refunded")).toThrow(/Unknown status/);
  });
});

describe("stick drift config", () => {
  it("defaults the price to 4999 and reads PRICE_CENTS", () => {
    expect(priceCents({})).toBe(4999);
    expect(priceCents({ PRICE_CENTS: "5999" })).toBe(5999);
    expect(priceCents({ PRICE_CENTS: "free" })).toBe(4999);
    expect(priceCents({ PRICE_CENTS: "-5" })).toBe(4999);
  });

  it("normalizes SITE_URL to an origin", () => {
    expect(siteOrigin({ SITE_URL: "https://wefixstickdrift.com/" })).toBe("https://wefixstickdrift.com");
    expect(siteOrigin({})).toBe("");
    expect(siteOrigin({ SITE_URL: "not a url" })).toBe("");
  });

  it("parses RECEIVING_ADDRESS and defaults the name", () => {
    const json = JSON.stringify({ street: "1 Main St", city: "Houston", state: "tx", zip: "77002" });
    expect(receivingAddress({ RECEIVING_ADDRESS: json })).toEqual({
      name: "We Fix Stick Drift",
      street: "1 Main St",
      city: "Houston",
      state: "TX",
      zip: "77002",
    });
    expect(receivingAddress({})).toBeNull();
    expect(receivingAddress({ RECEIVING_ADDRESS: "{oops" })).toBeNull();
    expect(receivingAddress({ RECEIVING_ADDRESS: JSON.stringify({ street: "1 Main St", city: "Houston", state: "TX" }) })).toBeNull();
  });

  it("lists what is missing", () => {
    expect(stickDriftReadiness({})).toHaveLength(3);
    expect(US_STATES).toHaveLength(51);
  });
});
