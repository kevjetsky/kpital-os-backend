import mongoose from "mongoose";

const inventoryTransactionSchema = new mongoose.Schema(
  {
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: "InventoryItem", required: true },
    type: { type: String, required: true, enum: ["in", "out", "adjustment"] },
    quantity: { type: Number, required: true },
    reason: { type: String, default: "", trim: true },
    quantityBefore: { type: Number, required: true },
    quantityAfter: { type: Number, required: true }
  },
  { timestamps: true }
);

inventoryTransactionSchema.index({ itemId: 1, createdAt: -1 });

export const InventoryTransaction = mongoose.model("InventoryTransaction", inventoryTransactionSchema);
