import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

const entrySchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Every query must be scoped by this;
    // without it one business would read another's financial records.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    date: { type: Date, required: true },
    type: {
      type: String,
      required: true,
      enum: ["Repair", "Sales", "Expenses", "Tip"]
    },
    description: { type: String, default: "", trim: true },
    income: { type: Number, required: true, default: 0 },
    expense: { type: Number, required: true, default: 0 },
    salesTax: { type: Number, required: true, default: 0 },
    netProfit: { type: Number, required: true, default: 0 },
    customerName: { type: String, default: "", trim: true },
    customerPhone: { type: String, default: "", trim: true },
    customerInstagram: { type: String, default: "", trim: true },
    customerEmail: { type: String, default: "", trim: true },
    customerAddress: { type: String, default: "", trim: true },
    customerReference: { type: String, default: "", trim: true },
    customerOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    productServiceName: { type: String, default: "", trim: true },
    productServiceType: {
      type: String,
      enum: ["", "product", "service"],
      default: ""
    },
    productServicePrice: { type: Number, required: true, default: 0 },
    productServiceOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    inventoryUsage: [
      {
        itemId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
        name: { type: String, default: "", trim: true },
        sku: { type: String, default: "", trim: true },
        quantity: { type: Number, required: true },
        costPerUnit: { type: Number, required: true, default: 0 },
        totalCost: { type: Number, required: true, default: 0 }
      }
    ],
    inventoryCost: { type: Number, required: true, default: 0 },
    notes: { type: String, default: "", trim: true },
    category: { type: String, default: "", trim: true },
    // Warranty callback: this record is rework on a previous job. callbackOf
    // points at the original entry so failure rates and time-to-failure can be
    // computed; it may be null for callbacks whose original job predates the app.
    isWarrantyCallback: { type: Boolean, default: false },
    callbackOf: { type: mongoose.Schema.Types.ObjectId, ref: "Entry", default: null },
    callbackReason: { type: String, default: "", trim: true },
    // How this record was (or will be) paid. Must be set once the record is Paid.
    paymentMethod: { type: String, default: "", trim: true },
    payments: [
      {
        amount: { type: Number, required: true },
        date: { type: Date, required: true },
        method: { type: String, default: "", trim: true },
        note: { type: String, default: "", trim: true },
        createdAt: { type: Date, default: Date.now }
      }
    ],
    status: {
      type: String,
      required: true,
      enum: ["Pending", "Completed", "Paid"],
      default: "Pending"
    }
  },
  { timestamps: true }
);

entrySchema.set("optimisticConcurrency", true);

// accountId leads every index: all reads are scoped to one account, so it must
// be the first key for these to be usable.
entrySchema.index({ accountId: 1, date: -1, createdAt: -1 });
entrySchema.index({ accountId: 1, type: 1, status: 1, date: -1 });
entrySchema.index({ accountId: 1, customerOptionId: 1, type: 1, date: -1 });
entrySchema.index({ accountId: 1, isWarrantyCallback: 1, date: -1 });

tenantGuard(entrySchema, { modelName: "Entry" });

export const Entry = mongoose.model("Entry", entrySchema);
