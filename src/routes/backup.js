import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils.js";
import { Entry } from "../models/Entry.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryTransaction } from "../models/InventoryTransaction.js";

const router = Router();

// Full data export, excluding auth settings (password hash never leaves the server).
router.get("/", requireAuth, asyncHandler(async (_req, res) => {
  const [entries, referenceOptions, inventoryItems, inventoryTransactions] =
    await Promise.all([
      Entry.find().sort({ date: 1 }).lean(),
      ReferenceOption.find().lean(),
      InventoryItem.find().lean(),
      InventoryTransaction.find().sort({ createdAt: 1 }).lean()
    ]);

  res.json({
    exportedAt: new Date().toISOString(),
    counts: {
      entries: entries.length,
      referenceOptions: referenceOptions.length,
      inventoryItems: inventoryItems.length,
      inventoryTransactions: inventoryTransactions.length
    },
    entries,
    referenceOptions,
    inventoryItems,
    inventoryTransactions
  });
}));

export default router;
