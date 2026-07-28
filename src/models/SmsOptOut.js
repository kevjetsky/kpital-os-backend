import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

// Phone numbers that have replied STOP.
//
// Keyed on the normalized phone rather than on a customer id on purpose: an
// inbound STOP webhook gives us a number and nothing else, and the suppression
// has to hold even if the customer record is later renamed, merged, or deleted.
// Storing this as a flag on ReferenceOption would lose the opt-out exactly when
// a duplicate customer is created — which is when we would most likely text
// someone who already told us to stop.
const smsOptOutSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    // Digits-only, country code stripped — same shape as ReferenceOption.phoneKey.
    phoneKey: { type: String, required: true, trim: true },
    source: { type: String, enum: ["inbound-stop", "manual"], default: "inbound-stop" },
    keyword: { type: String, default: "", trim: true },
    optedOutAt: { type: Date, default: Date.now }
  },
  { timestamps: true }
);

smsOptOutSchema.index({ accountId: 1, phoneKey: 1 }, { unique: true });

tenantGuard(smsOptOutSchema, { modelName: "SmsOptOut" });

export const SmsOptOut = mongoose.model("SmsOptOut", smsOptOutSchema);
