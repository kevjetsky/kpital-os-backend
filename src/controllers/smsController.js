import mongoose from "mongoose";
import { Settings } from "../models/Settings.js";
import { Entry } from "../models/Entry.js";
import { SmsMessage } from "../models/SmsMessage.js";
import { SmsOptOut } from "../models/SmsOptOut.js";
import { asyncHandler, normalizePhoneKey, toE164US } from "../utils.js";
import { ENTRY_TYPES, WARRANTY_DAYS } from "../constants.js";
import { isProviderConfigured } from "../services/smsService.js";
import {
  buildWarrantyMessage,
  clearWarrantyAttempt,
  sendWarrantySms
} from "../services/warrantySmsService.js";

const PROVIDERS = ["telnyx", "twilio", "noop"];

// Keywords carriers treat as an opt-out. Carriers also handle these themselves,
// but we mirror them so our own sender stops too.
const STOP_KEYWORDS = ["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"];
const START_KEYWORDS = ["START", "UNSTOP", "YES"];

function publicSmsSettings(sms = {}) {
  return {
    enabled: !!sms.enabled,
    dryRun: sms.dryRun !== false,
    provider: sms.provider || "noop",
    fromNumber: sms.fromNumber || "",
    entryTypes: sms.entryTypes?.length ? sms.entryTypes : ["Repair"],
    businessName: sms.businessName || "",
    callbackPhone: sms.callbackPhone || "",
    reviewUrl: sms.reviewUrl || "",
    template: sms.template || "",
    // Whether carrier credentials exist in the environment. Never the values —
    // this endpoint is only here so the UI can warn before a live send fails.
    providerConfigured: isProviderConfigured(sms.provider || "noop"),
    warrantyDays: WARRANTY_DAYS
  };
}

export const getSettings = asyncHandler(async (req, res) => {
  const account = await Settings.findById(req.accountId).select("sms").lean();
  return res.json(publicSmsSettings(account?.sms));
});

export const updateSettings = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const account = await Settings.findById(req.accountId).select("sms");
  if (!account) return res.status(404).json({ message: "Account not found." });

  const sms = account.sms || {};

  if (body.provider !== undefined) {
    if (!PROVIDERS.includes(String(body.provider))) {
      return res.status(400).json({ message: `Provider must be one of ${PROVIDERS.join(", ")}.` });
    }
    sms.provider = String(body.provider);
  }

  if (body.fromNumber !== undefined) {
    const raw = String(body.fromNumber || "").trim();
    if (raw && !toE164US(raw)) {
      return res.status(400).json({ message: "Sending number must be a valid US phone number." });
    }
    sms.fromNumber = raw ? toE164US(raw) : "";
  }

  if (body.callbackPhone !== undefined) sms.callbackPhone = String(body.callbackPhone || "").trim();
  if (body.businessName !== undefined) sms.businessName = String(body.businessName || "").trim();
  if (body.reviewUrl !== undefined) sms.reviewUrl = String(body.reviewUrl || "").trim();
  if (body.template !== undefined) {
    const template = String(body.template || "").trim();
    if (!template) return res.status(400).json({ message: "Message template cannot be empty." });
    sms.template = template;
  }

  if (body.entryTypes !== undefined) {
    const types = Array.isArray(body.entryTypes) ? body.entryTypes.map(String) : [];
    const invalid = types.filter((type) => !ENTRY_TYPES.includes(type));
    if (invalid.length > 0) {
      return res.status(400).json({ message: `Unknown record type: ${invalid.join(", ")}.` });
    }
    if (types.length === 0) {
      return res.status(400).json({ message: "Pick at least one record type to text about." });
    }
    sms.entryTypes = types;
  }

  if (body.dryRun !== undefined) sms.dryRun = Boolean(body.dryRun);

  // Turning on live sending is the moment real customers start receiving texts,
  // so it is gated on the configuration actually being complete rather than
  // failing silently later, one skipped record at a time.
  if (body.enabled !== undefined) {
    const enabling = Boolean(body.enabled);
    if (enabling && !sms.dryRun) {
      if (!sms.fromNumber) {
        return res.status(400).json({ message: "Add a sending number before enabling live texts." });
      }
      if (!isProviderConfigured(sms.provider)) {
        return res.status(400).json({
          message: `Credentials for ${sms.provider} are not configured on the server.`
        });
      }
    }
    sms.enabled = enabling;
  }

  account.sms = sms;
  await account.save();
  return res.json(publicSmsSettings(account.sms));
});

// Renders the message for a made-up record so the settings screen can show the
// exact text and its segment count before anything is sent.
export const preview = asyncHandler(async (req, res) => {
  const account = await Settings.findById(req.accountId).select("sms").lean();
  const sms = { ...(account?.sms || {}) };

  // Let the caller preview unsaved edits.
  for (const field of ["template", "businessName", "callbackPhone", "reviewUrl"]) {
    if (req.body?.[field] !== undefined) sms[field] = String(req.body[field] || "");
  }

  const sample = {
    _id: "preview",
    type: "Repair",
    customerPhone: "512-555-0142",
    warrantyNumber: "K7X2M9",
    warrantyStartsAt: new Date(),
    warrantyEndsAt: new Date(Date.now() + WARRANTY_DAYS * 86400000)
  };

  const { body, segments, encoding, length, offenders } = buildWarrantyMessage(sample, sms);
  return res.json({ body, segments, encoding, length, offenders });
});

export const listForEntry = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }
  const messages = await SmsMessage.find({ accountId: req.accountId, entryId })
    .sort({ createdAt: -1 })
    .lean();
  return res.json(messages);
});

// Manual retry. Clears the idempotency claim first, which is the only supported
// way to text the same record twice — deliberately an explicit owner action.
export const resend = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const entry = await Entry.findOne({ _id: entryId, accountId: req.accountId }).lean();
  if (!entry) return res.status(404).json({ message: "Entry not found." });

  const account = await Settings.findById(req.accountId).select("sms").lean();
  if (!account?.sms?.enabled) {
    return res.status(400).json({ message: "Warranty texts are switched off." });
  }
  if (!entry.warrantyNumber) {
    return res.status(400).json({ message: "This record has no warranty number yet. Mark it Completed or Paid first." });
  }

  await clearWarrantyAttempt(req.accountId, entryId);
  const result = await sendWarrantySms(req.accountId, entry, account.sms);
  return res.json(result);
});

export const listOptOuts = asyncHandler(async (req, res) => {
  const optOuts = await SmsOptOut.find({ accountId: req.accountId }).sort({ optedOutAt: -1 }).lean();
  return res.json(optOuts);
});

// Inbound carrier webhook. Normalizes Telnyx and Twilio payload shapes into
// { from, text } and records STOP/START.
export const inbound = asyncHandler(async (req, res) => {
  const accountId = String(req.params?.accountId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(accountId)) {
    return res.status(400).json({ message: "Invalid account id." });
  }

  const body = req.body ?? {};
  const from =
    body?.data?.payload?.from?.phone_number || // Telnyx
    body?.From || // Twilio
    body?.from ||
    "";
  const text = body?.data?.payload?.text || body?.Body || body?.text || "";

  const phoneKey = normalizePhoneKey(from);
  const keyword = String(text).trim().toUpperCase().split(/\s+/)[0] || "";

  if (!phoneKey) {
    // Acknowledge anyway: retrying a malformed webhook helps nobody.
    return res.json({ ok: true, action: "ignored" });
  }

  if (STOP_KEYWORDS.includes(keyword)) {
    await SmsOptOut.updateOne(
      { accountId, phoneKey },
      { $set: { source: "inbound-stop", keyword, optedOutAt: new Date() } },
      { upsert: true }
    );
    return res.json({ ok: true, action: "opted-out" });
  }

  if (START_KEYWORDS.includes(keyword)) {
    await SmsOptOut.deleteOne({ accountId, phoneKey });
    return res.json({ ok: true, action: "opted-in" });
  }

  return res.json({ ok: true, action: "ignored" });
});
