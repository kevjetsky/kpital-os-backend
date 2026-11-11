import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireCronSecret } from "../middleware/cron.js";
import { asyncHandler } from "../utils.js";
import { Entry } from "../models/Entry.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryTransaction } from "../models/InventoryTransaction.js";
import { RecurringEntry } from "../models/RecurringEntry.js";
import { TaxRemittance } from "../models/TaxRemittance.js";
import { StickDriftWorkOrder } from "../models/StickDriftWorkOrder.js";
import { SmsMessage } from "../models/SmsMessage.js";
import { SmsOptOut } from "../models/SmsOptOut.js";
import { runBackup } from "../services/backupService.js";

const router = Router();

// POST /api/backup/cron/run — dumps the whole database to Cloud Storage. Called
// by the Cloudflare cron (shared secret), same as the recurring cron.
router.post("/cron/run", requireCronSecret, asyncHandler(async (_req, res) => {
  const result = await runBackup();
  console.log("Backup written:", JSON.stringify(result));
  return res.json({ ok: true, ...result });
}));

// Full export of one account's data, excluding auth settings (password hash
// never leaves the server).
router.get("/", requireAuth, asyncHandler(async (req, res) => {
  const scope = { accountId: req.accountId };
  const data = Object.fromEntries(
    await Promise.all(
      Object.entries({
        entries: Entry.find(scope).sort({ date: 1 }),
        referenceOptions: ReferenceOption.find(scope),
        inventoryItems: InventoryItem.find(scope),
        inventoryTransactions: InventoryTransaction.find(scope).sort({ createdAt: 1 }),
        recurringEntries: RecurringEntry.find(scope),
        taxRemittances: TaxRemittance.find(scope).sort({ createdAt: 1 }),
        stickDriftWorkOrders: StickDriftWorkOrder.find(scope).sort({ createdAt: 1 }),
        smsMessages: SmsMessage.find(scope).sort({ createdAt: 1 }),
        smsOptOuts: SmsOptOut.find(scope)
      }).map(async ([name, query]) => [name, await query.lean()])
    )
  );

  res.json({
    exportedAt: new Date().toISOString(),
    counts: Object.fromEntries(Object.entries(data).map(([name, docs]) => [name, docs.length])),
    ...data
  });
}));

export default router;
