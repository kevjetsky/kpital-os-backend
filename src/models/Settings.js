import mongoose from "mongoose";

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
