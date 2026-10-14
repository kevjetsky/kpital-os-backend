// Gives every existing sale, repair and refund a sequential invoice number
// (INV-1001, INV-1002, ...) in the order the records were dated, and sets each
// account's counter past the last one, so new records carry on from there.
//
// Safe to run more than once: records that already have a number keep it, and
// numbering continues after the highest number already used.
//
// Usage (from backend/):  node --env-file=.env scripts/migrate-invoice-numbers.mjs [--dry-run]
// Take a backup first:     node --env-file=.env scripts/backup-db.mjs

import mongoose from "mongoose";

const INVOICED_TYPES = ["Sales", "Repair", "Refund"];
const FIRST = 1001;
const dryRun = process.argv.includes("--dry-run");

const seqOf = (number) => {
  const match = /^INV-(\d+)$/.exec(String(number || ""));
  return match ? Number(match[1]) - (FIRST - 1) : 0;
};

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const entries = db.collection("entries");
  const counters = db.collection("invoiceCounters");

  const accountIds = await entries.distinct("accountId", { type: { $in: INVOICED_TYPES } });
  for (const accountId of accountIds) {
    const numbered = await entries
      .find({ accountId, invoiceNumber: { $gt: "" } }, { projection: { invoiceNumber: 1 } })
      .toArray();
    const counter = await counters.findOne({ accountId });
    let seq = Math.max(counter?.seq || 0, ...numbered.map((entry) => seqOf(entry.invoiceNumber)));

    const missing = await entries
      .find(
        { accountId, type: { $in: INVOICED_TYPES }, $or: [{ invoiceNumber: { $exists: false } }, { invoiceNumber: "" }] },
        { projection: { _id: 1, date: 1, createdAt: 1 } }
      )
      .sort({ date: 1, createdAt: 1, _id: 1 })
      .toArray();

    const first = seq + 1;
    for (const entry of missing) {
      seq += 1;
      if (!dryRun) {
        await entries.updateOne({ _id: entry._id }, { $set: { invoiceNumber: `INV-${FIRST - 1 + seq}` } });
      }
    }
    if (!dryRun) {
      await counters.updateOne({ accountId }, { $set: { seq } }, { upsert: true });
    }
    console.log(
      "%s account %s: %d record(s) numbered%s, counter now %d",
      dryRun ? "[dry run]" : "",
      String(accountId),
      missing.length,
      missing.length ? ` (INV-${FIRST - 1 + first} to INV-${FIRST - 1 + seq})` : "",
      seq
    );
  }
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("Migration failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
