// Nightly off-site backup: every collection, gzipped, into a Cloud Storage
// bucket. Triggered by the Cloudflare cron like the other scheduled jobs.
//
// Talks to Cloud Storage over plain HTTPS with the token App Engine hands its
// own service account, so it needs no SDK and no stored credential. The bucket
// must be private: the dump holds every account's records and password hashes.

import { gunzipSync, gzipSync } from "node:zlib";
import mongoose from "mongoose";
import { STORAGE_API, accessToken, storageRequest } from "./cloudStorage.js";

const PREFIX = "kpital-backup-";
const DEFAULT_KEEP = 30;

export class BackupNotConfiguredError extends Error {
  constructor() {
    super("Backup is not configured.");
    this.status = 503;
  }
}

function keepCount(env) {
  const value = Number(env.BACKUP_KEEP);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_KEEP;
}

// Extended JSON rather than plain JSON, so ids and dates come back as ids and
// dates when a dump is restored instead of as strings.
export async function dumpDatabase(db = mongoose.connection.db) {
  const { EJSON } = mongoose.mongo.BSON;
  const collections = {};
  const counts = {};
  const names = (await db.listCollections().toArray()).map(({ name }) => name).sort();
  for (const name of names) {
    const docs = await db.collection(name).find({}).toArray();
    collections[name] = docs;
    counts[name] = docs.length;
  }
  const body = EJSON.stringify(
    { exportedAt: new Date().toISOString(), format: "ejson", counts, collections },
    { relaxed: true }
  );
  return { counts, gzipped: gzipSync(body) };
}

async function listBackups(fetchImpl, token, bucket) {
  const names = [];
  let pageToken = "";
  do {
    const url = new URL(`${STORAGE_API}/storage/v1/b/${encodeURIComponent(bucket)}/o`);
    url.searchParams.set("prefix", PREFIX);
    url.searchParams.set("fields", "items(name),nextPageToken");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const data = await (await storageRequest(fetchImpl, token, url)).json();
    for (const item of data.items || []) names.push(item.name);
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  // Names carry an ISO timestamp, so sorting them sorts by age.
  return names.sort();
}

// Dumps the database, uploads it, and deletes all but the newest BACKUP_KEEP
// dumps. Pruning happens only after a successful upload, so a failing night
// never eats into the history.
export async function runBackup({ env = process.env, fetchImpl = fetch, now = new Date(), db } = {}) {
  const bucket = String(env.BACKUP_BUCKET || "").trim();
  if (!bucket) throw new BackupNotConfiguredError();

  const { counts, gzipped } = await dumpDatabase(db);
  const token = await accessToken(fetchImpl);
  const file = `${PREFIX}${now.toISOString().replace(/[:.]/g, "-")}.json.gz`;

  const upload = new URL(`${STORAGE_API}/upload/storage/v1/b/${encodeURIComponent(bucket)}/o`);
  upload.searchParams.set("uploadType", "media");
  upload.searchParams.set("name", file);
  await storageRequest(fetchImpl, token, upload, {
    method: "POST",
    headers: { "Content-Type": "application/gzip" },
    body: gzipped
  });

  const existing = await listBackups(fetchImpl, token, bucket);
  const stale = existing.slice(0, Math.max(0, existing.length - keepCount(env)));
  for (const name of stale) {
    await storageRequest(
      fetchImpl,
      token,
      `${STORAGE_API}/storage/v1/b/${encodeURIComponent(bucket)}/o/${encodeURIComponent(name)}`,
      { method: "DELETE" }
    );
  }

  return { file, bucket, bytes: gzipped.length, counts, kept: existing.length - stale.length, pruned: stale.length };
}

// Reads a dump written by dumpDatabase back into { counts, collections }.
export function readDump(gzipped) {
  const { EJSON } = mongoose.mongo.BSON;
  const dump = EJSON.parse(gunzipSync(gzipped).toString("utf8"));
  if (!dump || dump.format !== "ejson" || typeof dump.collections !== "object") {
    throw new Error("This file is not a Kpital OS backup.");
  }
  return dump;
}

// Puts a dump back. Refuses a database that already holds records unless told
// to replace them, so a restore pointed at the wrong place cannot quietly mix
// two sets of data. With `replace`, each collection in the dump is emptied
// first; collections the dump does not mention are left alone. Indexes are not
// part of a dump: the app rebuilds them when it next starts.
export async function restoreDump(db, gzipped, { replace = false } = {}) {
  const dump = readDump(gzipped);
  const names = Object.keys(dump.collections);

  if (!replace) {
    for (const name of names) {
      if ((await db.collection(name).estimatedDocumentCount()) > 0) {
        throw new Error(`The database already has records in "${name}". Nothing was restored.`);
      }
    }
  }

  const restored = {};
  for (const name of names) {
    const docs = dump.collections[name];
    if (replace) await db.collection(name).deleteMany({});
    if (docs.length > 0) await db.collection(name).insertMany(docs, { ordered: true });
    restored[name] = docs.length;
  }
  return { exportedAt: dump.exportedAt, restored };
}
