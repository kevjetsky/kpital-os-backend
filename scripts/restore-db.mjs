// Puts a nightly backup back into a database.
//
// The backups are written by POST /api/backup/cron/run to the private bucket in
// BACKUP_BUCKET, one kpital-backup-<timestamp>.json.gz per night. Fetch one:
//
//   gcloud storage ls gs://<bucket>/
//   gcloud storage cp gs://<bucket>/kpital-backup-<timestamp>.json.gz .
//
// Then, from backend/:
//
//   node --env-file=.env scripts/restore-db.mjs <file.json.gz>             look only: what is in the file
//   node --env-file=.env scripts/restore-db.mjs <file.json.gz> --apply     restore into an EMPTY database
//   node --env-file=.env scripts/restore-db.mjs <file.json.gz> --apply --replace
//                                                                          replace what is there
//
// It writes to the database in MONGODB_URI. Point that at a scratch database
// first when rehearsing. Without --apply nothing is written. --replace empties
// each collection the backup holds before filling it; there is no undo, so take
// a fresh backup of the current state first (node scripts/backup-db.mjs).

import fs from "node:fs/promises";
import mongoose from "mongoose";
import { readDump, restoreDump } from "../src/services/backupService.js";

const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith("--"));
const apply = args.includes("--apply");
const replace = args.includes("--replace");

async function main() {
  if (!file) {
    console.error("Usage: node scripts/restore-db.mjs <kpital-backup-....json.gz> [--apply] [--replace]");
    process.exit(1);
  }
  const gzipped = await fs.readFile(file);
  const dump = readDump(gzipped);
  console.log("Backup taken %s", dump.exportedAt);
  for (const [name, count] of Object.entries(dump.counts)) console.log("  %s: %d", name, count);

  if (!apply) {
    console.log("Nothing was written. Add --apply to restore.");
    return;
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const { host, name } = mongoose.connection;
  console.log("Restoring into database \"%s\" on %s%s", name, host, replace ? " (replacing what is there)" : "");
  const result = await restoreDump(mongoose.connection.db, gzipped, { replace });
  for (const [collection, count] of Object.entries(result.restored)) console.log("  restored %s: %d", collection, count);
  console.log("Done. Restart the API so it rebuilds its indexes.");
}

main()
  .catch((error) => {
    console.error("Restore failed:", error?.message || error);
    process.exitCode = 1;
  })
  .finally(() => mongoose.connection.close().catch(() => {}));
