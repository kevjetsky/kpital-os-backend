import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

const inventoryTransactionSchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Every query must be scoped by this;
    // without it one business would read another's data.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    type: { type: String, required: true, enum: ["in", "out", "adjustment"] },
    quantity: { type: Number, required: true },
    reason: { type: String, default: "", trim: true },
    quantityBefore: { type: Number, required: true },
    quantityAfter: { type: Number, required: true }
  },
  { timestamps: true }
);

inventoryTransactionSchema.index({ accountId: 1, itemId: 1, createdAt: -1 });

tenantGuard(inventoryTransactionSchema, { modelName: "InventoryTransaction" });

export const InventoryTransaction = mongoose.model("InventoryTransaction", inventoryTransactionSchema);
