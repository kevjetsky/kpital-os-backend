import mongoose from "mongoose";
import { DEFAULT_WARRANTY_SMS_TEMPLATE } from "../constants.js";

const settingsSchema = new mongoose.Schema(
  {
    // Legacy discriminator from the single-account era. No longer unique: each
    // account is its own Settings document and is identified by email. Kept so
    // the original document (key: "main") still validates.
    key: { type: String, default: "" },
    passwordHash: { type: String, required: true },
    // Owner login email. Empty on legacy documents created before email auth;
    // those are upgraded through the setup flow.
    email: { type: String, default: "" },
    emailVerified: { type: Boolean, default: false },
    // Pending one-time code (bcrypt hash, never the raw code). Purpose says
    // what the code is for: "email" (verify address) or "reset" (password).
    verificationCodeHash: { type: String, default: "" },
    verificationCodeExpiresAt: { type: Date, default: null },
    verificationAttempts: { type: Number, default: 0 },
    verificationPurpose: { type: String, enum: ["", "email", "reset"], default: "" },
    // Which push notifications the owner wants. All on by default.
    notificationPrefs: {
      lowStock: { type: Boolean, default: true },
      quarterlyTax: { type: Boolean, default: true },
      recurringPosted: { type: Boolean, default: true },
      weeklySummary: { type: Boolean, default: true }
    },
    // Dedupe markers so periodic reminders fire once per period, not every run.
    notificationState: {
      lastWeeklySummaryAt: { type: Date, default: null },
      lastQuarterlyTaxPeriod: { type: String, default: "" } // e.g. "2026-Q2"
    },
    // Customer-facing warranty SMS. Off by default and dry-run by default:
    // turning this on starts sending real texts to real customers, so it must
    // be a deliberate act, never a side effect of deploying.
    sms: {
      enabled: { type: Boolean, default: false },
      // dryRun renders and logs the message without handing it to a carrier.
      dryRun: { type: Boolean, default: true },
      provider: { type: String, enum: ["telnyx", "twilio", "noop"], default: "noop" },
      fromNumber: { type: String, default: "", trim: true },
      // Which record types get a warranty text. Repair only by default, since
      // that is what the warranty window actually covers.
      entryTypes: { type: [String], default: ["Repair"] },
      businessName: { type: String, default: "", trim: true },
      // Number printed in the text for the customer to call back.
      callbackPhone: { type: String, default: "", trim: true },
      reviewUrl: { type: String, default: "", trim: true },
      template: { type: String, default: DEFAULT_WARRANTY_SMS_TEMPLATE }
    }
  },
  { timestamps: true }
);

// Email is the account identifier and must be unique — but only among accounts
// that actually have one. The partial filter lets legacy/in-progress documents
// with an empty email coexist instead of colliding on "".
settingsSchema.index(
  { email: 1 },
  { unique: true, partialFilterExpression: { email: { $gt: "" } } }
);
settingsSchema.index(
  { key: 1 },
  { unique: true, partialFilterExpression: { key: "main" } }
);

export const Settings = mongoose.model("Settings", settingsSchema);
