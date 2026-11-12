// Receipt photos for expenses: one image per record, kept in a private Cloud
// Storage bucket (RECEIPTS_BUCKET) and only ever served back through the API
// to the account that owns the record.
import { randomBytes } from "node:crypto";
import { accessToken, objectUrl, storageRequest, uploadUrl } from "./cloudStorage.js";

export const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;

export class ReceiptsNotConfiguredError extends Error {
  constructor() {
    super("Receipt photos are not set up yet.");
    this.status = 503;
  }
}

function bucketOf(env) {
  const bucket = String(env.RECEIPTS_BUCKET || "").trim();
  if (!bucket) throw new ReceiptsNotConfiguredError();
  return bucket;
}

// What the bytes really are, whatever the upload claimed to be.
export function sniffImage(bytes) {
  if (!bytes || bytes.length < 12) return null;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { contentType: "image/jpeg", extension: "jpg" };
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { contentType: "image/png", extension: "png" };
  }
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

export async function saveReceipt({ accountId, entryId, bytes }, { env = process.env, fetchImpl = fetch, now = new Date() } = {}) {
  const bucket = bucketOf(env);
  const kind = sniffImage(bytes);
  if (!kind) throw Object.assign(new Error("The receipt must be a JPEG, PNG or WebP photo."), { status: 400 });

  // A fresh name every time, so a replaced photo is never served from a cache.
  const path = `receipts/${accountId}/${entryId}-${randomBytes(6).toString("hex")}.${kind.extension}`;
  const token = await accessToken(fetchImpl);
  await storageRequest(fetchImpl, token, uploadUrl(bucket, path), {
    method: "POST",
    headers: { "Content-Type": kind.contentType },
    body: bytes
  });
  return { path, contentType: kind.contentType, size: bytes.length, uploadedAt: now };
}

export async function readReceipt(path, { env = process.env, fetchImpl = fetch } = {}) {
  const token = await accessToken(fetchImpl);
  const res = await storageRequest(fetchImpl, token, `${objectUrl(bucketOf(env), path)}?alt=media`);
  return Buffer.from(await res.arrayBuffer());
}

// Best effort: a photo left behind in the bucket is a small cost, a failed
// record save or delete because of it would be a real one.
export async function deleteReceipt(path, { env = process.env, fetchImpl = fetch } = {}) {
  try {
    const token = await accessToken(fetchImpl);
    await storageRequest(fetchImpl, token, objectUrl(bucketOf(env), path), { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}
