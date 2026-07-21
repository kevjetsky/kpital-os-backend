import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

// A record of sales tax actually filed/remitted to the state for a given
// quarter. The app already accrues "tax collected" from entries; this ledger
// tracks what has been paid out so we can show tax still owed per quarter.
const taxRemittanceSchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Every query must be scoped by this;
    // without it one business would read another's data.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    period: { type: String, required: true, trim: true }, // e.g. "2026-Q2"
    year: { type: Number, required: true },
    quarter: { type: Number, required: true, min: 1, max: 4 },
    amount: { type: Number, required: true, default: 0 },
    dateFiled: { type: Date, required: true },
    note: { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

taxRemittanceSchema.index({ accountId: 1, year: 1, quarter: 1 });

tenantGuard(taxRemittanceSchema, { modelName: "TaxRemittance" });

export const TaxRemittance = mongoose.model("TaxRemittance", taxRemittanceSchema);
