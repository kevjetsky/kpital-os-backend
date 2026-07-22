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
      enum: ["customer", "product_service"]
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
    optionType: {
      type: String,
      enum: ["", "product", "service"],
      default: ""
    },
    price: { type: Number, required: true, default: 0 },
    cost: { type: Number, required: true, default: 0 }
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
