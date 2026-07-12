import { describe, it, expect } from "vitest";
import {
  roundMoney,
  computeAmounts,
  parseMoneyInput,
  normalizePhoneKey,
  normalizeInstagramHandle,
  toPaymentMethod,
  deriveCustomerName
} from "../utils.js";

describe("roundMoney", () => {
  it("rounds to two decimal places", () => {
    expect(roundMoney(1.005)).toBe(1.01);
    expect(roundMoney(10.125)).toBe(10.13);
  });
  it("handles zero", () => {
    expect(roundMoney(0)).toBe(0);
  });
});

describe("computeAmounts", () => {
  it("computes salesTax as 8.25% of income", () => {
    const result = computeAmounts(100, 0);
    expect(result.salesTax).toBe(8.25);
  });
  it("computes netProfit correctly", () => {
    const result = computeAmounts(100, 20);
    // 100 - 20 - 8.25 = 71.75
    expect(result.netProfit).toBe(71.75);
  });
  it("handles non-finite values as zero", () => {
    const result = computeAmounts(NaN, undefined);
    expect(result.income).toBe(0);
    expect(result.expense).toBe(0);
  });
});

describe("parseMoneyInput", () => {
  it("returns rounded value for valid input", () => {
    const { value, error } = parseMoneyInput(10.555, "Amount");
    expect(error).toBeNull();
    expect(value).toBe(10.56);
  });
  it("rejects negative numbers", () => {
    const { error } = parseMoneyInput(-1, "Amount");
    expect(error).toBeTruthy();
  });
  it("rejects non-numeric input", () => {
    const { error } = parseMoneyInput("abc", "Amount");
    expect(error).toBeTruthy();
  });
  it("accepts zero", () => {
    const { value, error } = parseMoneyInput(0, "Amount");
    expect(error).toBeNull();
    expect(value).toBe(0);
  });
});

describe("normalizePhoneKey", () => {
  it("strips formatting", () => {
    expect(normalizePhoneKey("(555) 123-4567")).toBe("5551234567");
  });
  it("drops a leading US country code", () => {
    expect(normalizePhoneKey("+1 555 123 4567")).toBe("5551234567");
  });
  it("returns empty string for no digits", () => {
    expect(normalizePhoneKey("")).toBe("");
    expect(normalizePhoneKey("n/a")).toBe("");
  });
});

describe("normalizeInstagramHandle", () => {
  it("strips a leading @ and lowercases", () => {
    expect(normalizeInstagramHandle("@Jane.Doe")).toBe("jane.doe");
  });
  it("unwraps profile URLs", () => {
    expect(normalizeInstagramHandle("https://www.instagram.com/jane.doe/")).toBe("jane.doe");
    expect(normalizeInstagramHandle("instagram.com/jane")).toBe("jane");
  });
  it("returns empty string for blank input", () => {
    expect(normalizeInstagramHandle("")).toBe("");
    expect(normalizeInstagramHandle("@")).toBe("");
  });
});

describe("toPaymentMethod", () => {
  it("matches case-insensitively", () => {
    expect(toPaymentMethod("cash")).toBe("Cash");
    expect(toPaymentMethod("ZELLE")).toBe("Zelle");
  });
  it("matches spaced variants", () => {
    expect(toPaymentMethod("cashapp")).toBe("Cash App");
    expect(toPaymentMethod("cash_app")).toBe("Cash App");
    expect(toPaymentMethod("apple pay")).toBe("Apple Pay");
  });
  it("rejects unknown methods", () => {
    expect(toPaymentMethod("bitcoin")).toBe("");
    expect(toPaymentMethod("")).toBe("");
  });
});

describe("deriveCustomerName", () => {
  it("prefers the given name", () => {
    expect(deriveCustomerName("Jane", "555", "jane")).toBe("Jane");
  });
  it("falls back to phone, then instagram", () => {
    expect(deriveCustomerName("", "555-1234", "jane")).toBe("555-1234");
    expect(deriveCustomerName("", "", "@Jane")).toBe("@jane");
  });
  it("returns empty string when nothing is provided", () => {
    expect(deriveCustomerName("", "", "")).toBe("");
  });
});
