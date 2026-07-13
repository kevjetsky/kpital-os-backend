import mongoose from "mongoose";

// A record of sales tax actually filed/remitted to the state for a given
// quarter. The app already accrues "tax collected" from entries; this ledger
// tracks what has been paid out so we can show tax still owed per quarter.
const taxRemittanceSchema = new mongoose.Schema(
  {
    period: { type: String, required: true, trim: true }, // e.g. "2026-Q2"
    year: { type: Number, required: true },
    quarter: { type: Number, required: true, min: 1, max: 4 },
    amount: { type: Number, required: true, default: 0 },
    dateFiled: { type: Date, required: true },
    note: { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

taxRemittanceSchema.index({ year: 1, quarter: 1 });

export const TaxRemittance = mongoose.model("TaxRemittance", taxRemittanceSchema);
