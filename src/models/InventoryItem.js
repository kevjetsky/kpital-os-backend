import mongoose from "mongoose";

const inventoryItemSchema = new mongoose.Schema(
  {
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

inventoryItemSchema.index({ sku: 1 }, { unique: true });
inventoryItemSchema.index({ category: 1 });
inventoryItemSchema.index({ quantity: 1 });

export const InventoryItem = mongoose.model("InventoryItem", inventoryItemSchema);
