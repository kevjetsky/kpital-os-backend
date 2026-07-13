import mongoose from "mongoose";

const settingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true },
    passwordHash: { type: String, required: true },
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
