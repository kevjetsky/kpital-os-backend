// Full database dump, straight from Mongo. Unlike the /api/backup route this
// needs no auth token, covers every collection (including recurring entries and
// tax remittances, which that route omits), and is meant to be run immediately
// before a schema migration.
//
// Usage (from backend/):  node --env-file=.env scripts/backup-db.mjs [outDir]
// Writes <outDir>/kpital-backup-<timestamp>.json (default outDir: ./backups)

import fs from "node:fs/promises";
import path from "node:path";
import mongoose from "mongoose";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }

  const outDir = process.argv[2] || "backups";
  await fs.mkdir(outDir, { recursive: true });

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const collections = await db.listCollections().toArray();

  const dump = {};
  const counts = {};
  for (const { name } of collections) {
    const docs = await db.collection(name).find({}).toArray();
    dump[name] = docs;
    counts[name] = docs.length;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(outDir, `kpital-backup-${stamp}.json`);
  await fs.writeFile(
    file,
    JSON.stringify({ exportedAt: new Date().toISOString(), counts, collections: dump }, null, 2)
  );

  console.log("Collections backed up:");
  for (const [name, n] of Object.entries(counts)) {
    console.log("  %s: %d docs", name, n);
  }
  console.log("Written to %s", file);
  await mongoose.connection.close();
}

main().catch(async (err) => {
  console.error("Backup failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
