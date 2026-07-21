// One-off migration for account creation (phase 2).
//
// Before this, Settings held exactly one document enforced by a unique index on
// `key` ("main"). Each business is now its own Settings document identified by
// email, so:
//   1. the unique index on `key` must go, or a second account cannot be created
//   2. the existing email is lowercased, since lookups now normalize
//
// Usage (from backend/):
//   node --env-file=.env scripts/migrate-settings-multi-account.mjs [--dry-run]
//
// Idempotent. Run scripts/backup-db.mjs first.

import mongoose from "mongoose";

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const settings = mongoose.connection.db.collection("settings");

  if (DRY_RUN) console.log("--- DRY RUN: no writes will be made ---");

  // 1. Drop the singleton index on `key`.
  const indexes = await settings.indexes();
  const keyIndex = indexes.find((i) => i.name === "key_1");
  if (keyIndex) {
    if (DRY_RUN) {
      console.log("Would drop settings.key_1 (unique singleton index).");
    } else {
      await settings.dropIndex("key_1");
      console.log("Dropped settings.key_1.");
    }
  } else {
    console.log("settings.key_1 already absent.");
  }

  // 2. Lowercase existing emails so they match normalized lookups.
  const docs = await settings.find({ email: { $gt: "" } }).toArray();
  let normalized = 0;
  for (const doc of docs) {
    const lower = String(doc.email).trim().toLowerCase();
    if (lower === doc.email) continue;
    if (DRY_RUN) {
      console.log("Would normalize %s -> %s", doc.email, lower);
    } else {
      await settings.updateOne({ _id: doc._id }, { $set: { email: lower } });
      console.log("Normalized %s -> %s", doc.email, lower);
    }
    normalized += 1;
  }
  if (normalized === 0) console.log("All emails already normalized.");

  // 3. Guard against duplicates before the unique partial index is built, since
  // the index creation would otherwise fail on next app start.
  const dupes = await settings
    .aggregate([
      { $match: { email: { $gt: "" } } },
      { $group: { _id: "$email", n: { $sum: 1 } } },
      { $match: { n: { $gt: 1 } } },
    ])
    .toArray();
  if (dupes.length > 0) {
    console.error("Duplicate account emails found — resolve before deploying:");
    for (const d of dupes) console.error("  %s (%d accounts)", d._id, d.n);
    await mongoose.connection.close();
    process.exit(1);
  }
  console.log("Verified: no duplicate account emails.");

  const total = await settings.countDocuments({});
  console.log("Accounts: %d", total);

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
