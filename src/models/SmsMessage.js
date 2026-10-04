import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

// One row per warranty text we attempted, including the ones we deliberately
// did not send.
//
// This exists mainly to make double-texting impossible. A record can move
// Completed -> Paid -> Completed, and each of those saves would otherwise look
// like a fresh reason to text the customer. The unique index on
// { accountId, entryId, kind } is the enforcement: the send path inserts the
// log row first and treats a duplicate-key error as "already handled".
//
// Skipped attempts are recorded too, so "why didn't this customer get a text?"
// is answerable from data instead of guesswork.
const smsMessageSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    entryId: { type: mongoose.Schema.Types.ObjectId, ref: "Entry", required: true },
    kind: { type: String, required: true, default: "warranty" },
    status: {
      type: String,
      required: true,
      enum: ["sent", "failed", "skipped", "dry-run"],
      default: "skipped"
    },
    // Why we didn't send. Empty for successful sends.
    skipReason: {
      type: String,
      enum: [
        "",
        "no-phone",
        "unparseable-phone",
        "opted-out",
        "disabled",
        "not-configured",
        "ineligible-type",
        // The owner ticked "Don't text the customer" on the record itself.
        "suppressed"
      ],
      default: ""
    },
    toNumber: { type: String, default: "", trim: true },
    body: { type: String, default: "", trim: true },
    segments: { type: Number, default: 0 },
    encoding: { type: String, enum: ["", "GSM-7", "UCS-2"], default: "" },
    provider: { type: String, default: "", trim: true },
    // Carrier-side id, for chasing a delivery complaint.
    providerMessageId: { type: String, default: "", trim: true },
    error: { type: String, default: "", trim: true },
    sentAt: { type: Date, default: null }
  },
  { timestamps: true }
);

// The idempotency guard. See the note above: this is load-bearing, not just an
// optimisation — dropping it means customers get texted repeatedly.
smsMessageSchema.index({ accountId: 1, entryId: 1, kind: 1 }, { unique: true });
smsMessageSchema.index({ accountId: 1, createdAt: -1 });

tenantGuard(smsMessageSchema, { modelName: "SmsMessage" });

export const SmsMessage = mongoose.model("SmsMessage", smsMessageSchema);
