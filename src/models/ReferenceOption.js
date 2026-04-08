import mongoose from "mongoose";

const referenceOptionSchema = new mongoose.Schema(
  {
    kind: {
      type: String,
      required: true,
      enum: ["customer", "product_service"]
    },
    name: { type: String, required: true, trim: true },
    normalizedName: { type: String, required: true, trim: true },
    phone: { type: String, default: "", trim: true },
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

referenceOptionSchema.index({ kind: 1, normalizedName: 1 }, { unique: true });

export const ReferenceOption = mongoose.model("ReferenceOption", referenceOptionSchema);
