// One-off migration: relabel the retired "Parts" expense category to
// "Tools & Equipment" on both posted entries and recurring templates.
//
// Parts are now tracked only as inventory COGS (consumed on a repair/sale), so
// the standalone "Parts" expense category was removed to avoid double-counting.
// Any historical rows that used it are moved to "Tools & Equipment".
//
// Usage (from backend/):  MONGODB_URI="mongodb+srv://..." node scripts/migrate-parts-category.mjs
// Safe to run more than once (idempotent).

import mongoose from "mongoose";
import { Entry } from "../src/models/Entry.js";
import { RecurringEntry } from "../src/models/RecurringEntry.js";

const OLD = "Parts";
const NEW = "Tools & Equipment";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log("Connected. Migrating category %j -> %j ...", OLD, NEW);

  const entries = await Entry.updateMany({ category: OLD }, { $set: { category: NEW } });
  const recurring = await RecurringEntry.updateMany({ category: OLD }, { $set: { category: NEW } });

  console.log("Entries updated:   %d", entries.modifiedCount);
  console.log("Recurring updated: %d", recurring.modifiedCount);

  await mongoose.connection.close();
  console.log("Done.");
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
