// Pure-function coverage for the warranty SMS path. The segment maths carries
// real money: a message that silently drops to UCS-2 is billed at 70 characters
// per segment instead of 160, so a one-segment text becomes three.

import { describe, it, expect } from "vitest";
import { analyzeMessage, toGsm7Safe, isProviderConfigured } from "../services/smsService.js";
import {
  buildWarrantyMessage,
  evaluateEligibility,
  renderWarrantyMessage,
  warrantyWindow,
  isCompletionStatus
} from "../services/warrantySmsService.js";
import { toE164US, generateWarrantyNumber, normalizeWarrantyNumber } from "../utils.js";

describe("analyzeMessage", () => {
  it("counts a plain ASCII message as one GSM-7 segment", () => {
    const result = analyzeMessage("Kpital Tech: Repair #K7X2M9 done.");
    expect(result.encoding).toBe("GSM-7");
    expect(result.segments).toBe(1);
    expect(result.length).toBe(33);
  });

  it("holds exactly 160 GSM-7 characters in one segment", () => {
    expect(analyzeMessage("a".repeat(160)).segments).toBe(1);
    expect(analyzeMessage("a".repeat(161)).segments).toBe(2);
  });

  it("charges two units for GSM-7 extension characters", () => {
    // Each "{" costs an escape plus the character.
    const result = analyzeMessage("{".repeat(80));
    expect(result.encoding).toBe("GSM-7");
    expect(result.length).toBe(160);
    expect(result.segments).toBe(1);
    expect(analyzeMessage("{".repeat(81)).segments).toBe(2);
  });

  it("drops to UCS-2 and names the offender for a single emoji", () => {
    const result = analyzeMessage("Thanks for your business! 🎮");
    expect(result.encoding).toBe("UCS-2");
    expect(result.offenders).toContain("🎮");
  });

  it("shows the cost trap: one curly quote triples a 150-char message", () => {
    const plain = "a".repeat(150);
    expect(analyzeMessage(plain).segments).toBe(1);

    const withSmartQuote = "a".repeat(149) + "’";
    const result = analyzeMessage(withSmartQuote);
    expect(result.encoding).toBe("UCS-2");
    expect(result.segments).toBe(3);
  });

  it("treats an empty body as a single segment rather than zero", () => {
    expect(analyzeMessage("").segments).toBe(1);
  });
});

describe("toGsm7Safe", () => {
  it("rescues typographic characters that would force UCS-2", () => {
    const dirty = "Don’t — “thanks”…";
    const clean = toGsm7Safe(dirty);
    expect(analyzeMessage(dirty).encoding).toBe("UCS-2");
    expect(analyzeMessage(clean).encoding).toBe("GSM-7");
    expect(clean).toBe('Don\'t - "thanks"...');
  });

  it("leaves an emoji alone, since there is no ASCII equivalent to pick", () => {
    expect(analyzeMessage(toGsm7Safe("hi 🎮")).encoding).toBe("UCS-2");
  });
});

describe("toE164US", () => {
  it("normalizes the formats a phone number actually gets typed in", () => {
    for (const input of ["512-555-0142", "(512) 555-0142", "512.555.0142", "+1 512 555 0142", "15125550142"]) {
      expect(toE164US(input), input).toBe("+15125550142");
    }
  });

  it("rejects numbers that are not plausible US lines", () => {
    expect(toE164US("")).toBe("");
    expect(toE164US("555-0142")).toBe(""); // too short
    expect(toE164US("012-555-0142")).toBe(""); // area code cannot start with 0
    expect(toE164US("112-555-0142")).toBe(""); // area code cannot start with 1
    expect(toE164US("512-055-0142")).toBe(""); // exchange cannot start with 0
    expect(toE164US("+44 20 7946 0000")).toBe(""); // not US
  });
});

describe("warranty numbers", () => {
  it("never contains characters that are ambiguous when read aloud", () => {
    // 400 codes is enough to hit every alphabet slot with high probability.
    for (let i = 0; i < 400; i += 1) {
      expect(generateWarrantyNumber()).not.toMatch(/[ILOU]/);
    }
  });

  it("generates a fixed-length alphanumeric code", () => {
    const code = generateWarrantyNumber();
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^[0-9A-Z]{6}$/);
  });

  it("normalizes what a customer reads back over the phone", () => {
    expect(normalizeWarrantyNumber("k7x2m9")).toBe("K7X2M9");
    expect(normalizeWarrantyNumber("K7X-2M9")).toBe("K7X2M9");
    expect(normalizeWarrantyNumber(" k7x 2m9 ")).toBe("K7X2M9");
    // The classic mishearings map onto the canonical characters.
    expect(normalizeWarrantyNumber("KOX2M9")).toBe("K0X2M9");
    expect(normalizeWarrantyNumber("KIX2M9")).toBe("K1X2M9");
  });

  it("is deterministic under an injected generator", () => {
    expect(generateWarrantyNumber(() => 0)).toBe("000000");
  });
});

describe("warrantyWindow", () => {
  it("runs 40 days from completion", () => {
    const { start, end } = warrantyWindow(new Date("2026-07-25T00:00:00Z"), 40);
    expect(start.toISOString().slice(0, 10)).toBe("2026-07-25");
    expect(end.toISOString().slice(0, 10)).toBe("2026-09-03");
  });

  it("crosses a month boundary correctly", () => {
    const { end } = warrantyWindow(new Date("2026-12-20T00:00:00Z"), 40);
    expect(end.toISOString().slice(0, 10)).toBe("2027-01-29");
  });
});

describe("renderWarrantyMessage", () => {
  it("substitutes known placeholders", () => {
    expect(renderWarrantyMessage("Hi {business}, code {warranty}", { business: "Kpital", warranty: "K7X2M9" }))
      .toBe("Hi Kpital, code K7X2M9");
  });

  it("leaves an unknown placeholder visible instead of writing undefined", () => {
    expect(renderWarrantyMessage("{business} {typo}", { business: "Kpital" })).toBe("Kpital {typo}");
  });
});

const SETTINGS = {
  enabled: true,
  dryRun: true,
  provider: "noop",
  fromNumber: "+15125550100",
  entryTypes: ["Repair"],
  businessName: "Kpital Tech",
  callbackPhone: "512-555-0100",
  reviewUrl: "g.page/r/abc",
  template:
    "{business}: Repair #{warranty} done. {days}-day warranty thru {expires}. Issues? Call {phone}. Happy? Review: {review} Reply STOP to end"
};

const ENTRY = {
  _id: "e1",
  type: "Repair",
  customerPhone: "512-555-0142",
  warrantyNumber: "K7X2M9",
  warrantyStartsAt: new Date("2026-07-25T00:00:00Z"),
  warrantyEndsAt: new Date("2026-09-03T00:00:00Z")
};

describe("buildWarrantyMessage", () => {
  it("renders the default template as a single GSM-7 segment", () => {
    const result = buildWarrantyMessage(ENTRY, SETTINGS);
    expect(result.encoding).toBe("GSM-7");
    expect(result.segments).toBe(1);
    expect(result.body).toContain("K7X2M9");
    expect(result.body).toContain("40-day");
    expect(result.body).toContain("Sep 3");
    expect(result.body).toContain("512-555-0100");
    expect(result.body).toContain("g.page/r/abc");
    expect(result.body).toContain("STOP");
  });

  it("stays within one segment", () => {
    expect(buildWarrantyMessage(ENTRY, SETTINGS).length).toBeLessThanOrEqual(160);
  });

  it("does not leave double spaces when a placeholder is empty", () => {
    const result = buildWarrantyMessage(ENTRY, { ...SETTINGS, reviewUrl: "" });
    expect(result.body).not.toMatch(/ {2,}/);
  });

  it("derives the expiry from the start date when no end is stored", () => {
    const result = buildWarrantyMessage(
      { ...ENTRY, warrantyEndsAt: null },
      SETTINGS
    );
    expect(result.body).toContain("Sep 3");
  });
});

describe("evaluateEligibility", () => {
  it("accepts a complete Repair record", () => {
    expect(evaluateEligibility(ENTRY, SETTINGS)).toEqual({ eligible: true, reason: "" });
  });

  it("refuses when the feature is off", () => {
    expect(evaluateEligibility(ENTRY, { ...SETTINGS, enabled: false }).reason).toBe("disabled");
  });

  it("refuses a type that is not opted in", () => {
    expect(evaluateEligibility({ ...ENTRY, type: "Sales" }, SETTINGS).reason).toBe("ineligible-type");
    // ...but honours the setting when it is opted in.
    expect(
      evaluateEligibility({ ...ENTRY, type: "Sales" }, { ...SETTINGS, entryTypes: ["Repair", "Sales"] }).eligible
    ).toBe(true);
  });

  it("refuses a record with no phone, or an unusable one", () => {
    expect(evaluateEligibility({ ...ENTRY, customerPhone: "" }, SETTINGS).reason).toBe("no-phone");
    expect(evaluateEligibility({ ...ENTRY, customerPhone: "555" }, SETTINGS).reason).toBe("unparseable-phone");
  });

  it("refuses a live send with no sending number or credentials", () => {
    const live = { ...SETTINGS, dryRun: false, provider: "telnyx" };
    expect(evaluateEligibility(ENTRY, { ...live, fromNumber: "" }).reason).toBe("not-configured");
    // Credentials absent from the environment in tests.
    expect(evaluateEligibility(ENTRY, live).reason).toBe("not-configured");
  });

  it("allows a dry run without carrier credentials", () => {
    expect(evaluateEligibility(ENTRY, { ...SETTINGS, provider: "telnyx" }).eligible).toBe(true);
  });
});

describe("isProviderConfigured", () => {
  it("reads credentials from the injected environment", () => {
    expect(isProviderConfigured("telnyx", {})).toBe(false);
    expect(isProviderConfigured("telnyx", { TELNYX_API_KEY: "k" })).toBe(true);
    expect(isProviderConfigured("twilio", { TWILIO_ACCOUNT_SID: "a" })).toBe(false);
    expect(isProviderConfigured("twilio", { TWILIO_ACCOUNT_SID: "a", TWILIO_AUTH_TOKEN: "t" })).toBe(true);
    expect(isProviderConfigured("noop", {})).toBe(true);
    expect(isProviderConfigured("carrier-pigeon", {})).toBe(false);
  });
});

describe("isCompletionStatus", () => {
  it("treats Completed and Paid as done, Pending as not", () => {
    expect(isCompletionStatus("Completed")).toBe(true);
    expect(isCompletionStatus("Paid")).toBe(true);
    expect(isCompletionStatus("Pending")).toBe(false);
    expect(isCompletionStatus("")).toBe(false);
  });
});
