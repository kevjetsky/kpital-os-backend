import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
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

export const Settings = mongoose.model("Settings", settingsSchema);
