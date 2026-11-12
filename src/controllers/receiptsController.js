import mongoose from "mongoose";
import { Entry } from "../models/Entry.js";
import { asyncHandler } from "../utils.js";
import { deleteReceipt, readReceipt, saveReceipt } from "../services/receiptService.js";

async function findOwned(req, res) {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    res.status(400).json({ message: "Invalid entry id." });
    return null;
  }
  const entry = await Entry.findOne({ _id: id, accountId: req.accountId });
  if (!entry) {
    res.status(404).json({ message: "Entry not found." });
    return null;
  }
  return entry;
}

// POST /api/entries/:id/receipt — the photo itself is the request body.
export const upload = asyncHandler(async (req, res) => {
  const entry = await findOwned(req, res);
  if (!entry) return undefined;
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
    return res.status(400).json({ message: "Send the photo as the request body (JPEG, PNG or WebP)." });
  }

  const previous = entry.receipt?.path;
  const receipt = await saveReceipt({ accountId: req.accountId, entryId: entry._id, bytes: req.body });
  // Only this field: a photo must never disturb the record's amounts or status.
  await Entry.updateOne({ _id: entry._id, accountId: req.accountId }, { $set: { receipt } });
  if (previous) await deleteReceipt(previous);
  return res.status(201).json({ receipt });
});

// GET /api/entries/:id/receipt — the photo, to its owner only.
export const view = asyncHandler(async (req, res) => {
  const entry = await findOwned(req, res);
  if (!entry) return undefined;
  if (!entry.receipt?.path) return res.status(404).json({ message: "This record has no receipt photo." });

  const bytes = await readReceipt(entry.receipt.path);
  res.set("Content-Type", entry.receipt.contentType || "application/octet-stream");
  res.set("Cache-Control", "private, max-age=3600");
  // Never let a browser guess a different type for stored bytes.
  res.set("X-Content-Type-Options", "nosniff");
  return res.send(bytes);
});

// DELETE /api/entries/:id/receipt
export const remove = asyncHandler(async (req, res) => {
  const entry = await findOwned(req, res);
  if (!entry) return undefined;
  const path = entry.receipt?.path;
  if (!path) return res.json({ ok: true });
  await Entry.updateOne({ _id: entry._id, accountId: req.accountId }, { $unset: { receipt: 1 } });
  await deleteReceipt(path);
  return res.json({ ok: true });
});
