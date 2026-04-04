import { describe, it, expect } from "vitest";
import { roundMoney, computeAmounts, parseMoneyInput } from "../utils.js";

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
