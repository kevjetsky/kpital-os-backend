import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

const inventoryItemSchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Every query must be scoped by this;
    // without it one business would read another's data.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, required: true, trim: true },
    category: { type: String, default: "", trim: true },
    quantity: { type: Number, required: true, default: 0 },
    costPerUnit: { type: Number, required: true, default: 0 },
    supplier: { type: String, default: "", trim: true },
    lowStockThreshold: { type: Number, required: true, default: 5 },
    lastRestockedAt: { type: Date, default: null },
    // Dedupe flag for low-stock push notifications: set when we've alerted about
    // this item being low, cleared once it's restocked above threshold. Prevents
    // re-alerting on every daily cron run while stock stays low.
    lowStockNotified: { type: Boolean, default: false }
  },
  { timestamps: true }
);

// SKUs are unique per account, not globally: two businesses can both stock
// "HDMI-V21". The pre-tenancy index was { sku } and must be dropped — see
// scripts/migrate-add-account-id.mjs.
inventoryItemSchema.index({ accountId: 1, sku: 1 }, { unique: true });
inventoryItemSchema.index({ accountId: 1, category: 1 });
inventoryItemSchema.index({ accountId: 1, quantity: 1 });

tenantGuard(inventoryItemSchema, { modelName: "InventoryItem" });

export const InventoryItem = mongoose.model("InventoryItem", inventoryItemSchema);
