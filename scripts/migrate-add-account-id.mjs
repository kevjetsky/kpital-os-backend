// One-off migration: assign every pre-tenancy document to the existing owner's
// account, and replace the global unique indexes with per-account ones.
//
// Before multi-tenancy there was a single Settings document (key: "main") and
// all data was implicitly owned by it. That document's _id becomes the
// accountId for everything that already exists.
//
// Usage (from backend/):
//   node --env-file=.env scripts/migrate-add-account-id.mjs [--dry-run]
//
// Safe to run more than once (idempotent): documents that already carry an
// accountId are skipped. ALWAYS run scripts/backup-db.mjs first.

import mongoose from "mongoose";

const DRY_RUN = process.argv.includes("--dry-run");

// Collection name -> the pre-tenancy indexes that must be dropped because their
// replacements are now compound on accountId. Dropping is safe: mongoose
// recreates the new ones from the schema on next connect.
const STALE_INDEXES = {
  referenceoptions: ["kind_1_normalizedName_1"],
  inventoryitems: ["sku_1", "category_1", "quantity_1"],
  inventorytransactions: ["itemId_1_createdAt_-1"],
  entries: [
    "date_-1_createdAt_-1",
    "type_1_status_1_date_-1",
    "customerOptionId_1_type_1_date_-1",
    "isWarrantyCallback_1_date_-1",
  ],
  taxremittances: ["year_1_quarter_1"],
};

// Every tenant-scoped collection. The orphaned `appointments` and
// `appointmentsettings` collections left behind by commit 8fece66 (which removed
// the booking feature) were dropped on 2026-07-20 and are intentionally absent.
const TENANT_COLLECTIONS = [
  "entries",
  "referenceoptions",
  "inventoryitems",
  "inventorytransactions",
  "recurringentries",
  "taxremittances",
  "pushsubscriptions",
];

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;

  // The owning account is the existing singleton Settings document.
  const settings = await db.collection("settings").findOne({ key: "main" });
  if (!settings) {
    console.error('No settings document with key "main" — nothing to migrate.');
    await mongoose.connection.close();
    process.exit(1);
  }

  const accountId = settings._id;
  console.log("Owner account: %s (%s)", accountId, settings.email || "no email");
  if (DRY_RUN) console.log("--- DRY RUN: no writes will be made ---");

  let totalAssigned = 0;
  for (const name of TENANT_COLLECTIONS) {
    const collection = db.collection(name);
    const missing = await collection.countDocuments({ accountId: { $exists: false } });

    if (missing === 0) {
      const total = await collection.countDocuments({});
      console.log("  %s: already migrated (%d docs)", name, total);
      continue;
    }

    if (DRY_RUN) {
      console.log("  %s: would assign %d docs", name, missing);
      totalAssigned += missing;
      continue;
    }

    const result = await collection.updateMany(
      { accountId: { $exists: false } },
      { $set: { accountId } }
    );
    console.log("  %s: assigned %d docs", name, result.modifiedCount);
    totalAssigned += result.modifiedCount;
  }

  console.log(DRY_RUN ? "Would assign %d documents." : "Assigned %d documents.", totalAssigned);

  // Drop the pre-tenancy unique/query indexes. The compound replacements are
  // declared on the schemas and get built when the app next connects.
  console.log(DRY_RUN ? "Stale indexes that would be dropped:" : "Dropping stale indexes:");
  for (const [name, indexes] of Object.entries(STALE_INDEXES)) {
    const collection = db.collection(name);
    let existing;
    try {
      existing = (await collection.indexes()).map((i) => i.name);
    } catch {
      continue; // collection does not exist yet
    }

    for (const index of indexes) {
      if (!existing.includes(index)) continue;
      if (DRY_RUN) {
        console.log("  %s.%s", name, index);
        continue;
      }
      await collection.dropIndex(index);
      console.log("  dropped %s.%s", name, index);
    }
  }

  // A document left without an accountId is invisible to every scoped read, so
  // verify none remain rather than assuming the updates covered everything.
  if (!DRY_RUN) {
    let orphans = 0;
    for (const name of TENANT_COLLECTIONS) {
      const n = await db.collection(name).countDocuments({ accountId: { $exists: false } });
      if (n > 0) {
        console.error("  WARNING: %s still has %d documents without an accountId", name, n);
        orphans += n;
      }
    }
    if (orphans > 0) {
      console.error("Migration incomplete: %d orphaned documents.", orphans);
      await mongoose.connection.close();
      process.exit(1);
    }
    console.log("Verified: no documents left without an accountId.");
  }

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
