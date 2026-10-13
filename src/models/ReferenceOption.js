import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

const referenceOptionSchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Every query must be scoped by this;
    // without it one business would read another's data.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    kind: {
      type: String,
      required: true,
      enum: ["customer", "product_service", "business"]
    },
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, trim: true },
    phone: { type: String, default: "", trim: true },
    phoneKey: { type: String, default: "", trim: true },
    // Instagram handle stored without the leading @ (customer only).
    instagram: { type: String, default: "", trim: true },
    instagramKey: { type: String, default: "", trim: true },
    email: { type: String, default: "", trim: true },
    address: { type: String, default: "", trim: true },
    addressLine1: { type: String, default: "", trim: true },
    addressLine2: { type: String, default: "", trim: true },
    city: { type: String, default: "", trim: true },
    state: { type: String, default: "", trim: true },
    postalCode: { type: String, default: "", trim: true },
    reference: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    // Business (B2B account) only. contactName is the person to ask for at the
    // store. taxExempt is the default for new records sold to this business, and
    // taxExemptId is the resale/exemption certificate number that justifies it.
    contactName: { type: String, default: "", trim: true },
    taxExempt: { type: Boolean, default: false },
    taxExemptId: { type: String, default: "", trim: true },
    // When the certificate lapses. Null means it has no end date. Past this
    // date new records stop defaulting to tax exempt.
    taxExemptExpiresAt: { type: Date, default: null },
    // Which expiry reminder was last pushed, as "<stage>:<expiry date>", so each
    // stage ("soon", "expired") fires once per certificate date.
    taxExemptReminder: { type: String, default: "" },
    // Net payment terms in days (15 = net 15). 0 means no terms.
    paymentTermsDays: { type: Number, default: 0 },
    optionType: {
      type: String,
      enum: ["", "product", "service"],
      default: ""
    },
    price: { type: Number, required: true, default: 0 },
    cost: { type: Number, required: true, default: 0 },
    // Product/service only: the wholesale price charged on B2B records. Null
    // means there is none and B2B records use the normal price.
    b2bPrice: { type: Number, default: null }
  },
  { timestamps: true }
);

// Name uniqueness is per account: two businesses may both have a "Joystick Drift
// Repair". The pre-tenancy index was { kind, normalizedName } and must be
// dropped — see scripts/migrate-add-account-id.mjs.
referenceOptionSchema.index({ accountId: 1, kind: 1, normalizedName: 1 }, { unique: true });
referenceOptionSchema.index({ accountId: 1, kind: 1, phoneKey: 1 });
referenceOptionSchema.index({ accountId: 1, kind: 1, instagramKey: 1 });

tenantGuard(referenceOptionSchema, { modelName: "ReferenceOption" });

export const ReferenceOption = mongoose.model("ReferenceOption", referenceOptionSchema);
