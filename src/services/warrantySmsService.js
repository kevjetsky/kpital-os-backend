import { SmsMessage } from "../models/SmsMessage.js";
import { SmsOptOut } from "../models/SmsOptOut.js";
import { WARRANTY_DAYS } from "../constants.js";
import { normalizePhoneKey, toE164US } from "../utils.js";
import { analyzeMessage, isProviderConfigured, sendSms, toGsm7Safe } from "./smsService.js";

// Statuses that mean the work is finished and the warranty clock should start.
const COMPLETION_STATUSES = ["Completed", "Paid"];

export function isCompletionStatus(status) {
  return COMPLETION_STATUSES.includes(String(status || ""));
}

function formatExpiry(date) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC"
  }).format(date);
}

/** Warranty window for a job completed on `completedAt`. */
export function warrantyWindow(completedAt, days = WARRANTY_DAYS) {
  const start = new Date(completedAt);
  const end = new Date(start.getTime());
  end.setUTCDate(end.getUTCDate() + days);
  return { start, end };
}

/**
 * Fills the template. Unknown placeholders are left alone rather than replaced
 * with "undefined", so a typo in a custom template is visible instead of
 * quietly shipping broken text to a customer.
 */
export function renderWarrantyMessage(template, values) {
  return String(template || "").replace(/\{(\w+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] ?? "") : match
  );
}

/**
 * Builds the exact body that would be sent for an entry, plus its billing
 * shape. Exported so the settings screen can preview and count segments without
 * sending anything.
 */
export function buildWarrantyMessage(entry, smsSettings, { days = WARRANTY_DAYS } = {}) {
  const endsAt =
    entry.warrantyEndsAt || warrantyWindow(entry.warrantyStartsAt || entry.date || new Date(), days).end;

  const raw = renderWarrantyMessage(smsSettings?.template, {
    business: smsSettings?.businessName || "",
    warranty: entry.warrantyNumber || "",
    days: String(days),
    expires: formatExpiry(endsAt),
    phone: smsSettings?.callbackPhone || "",
    review: smsSettings?.reviewUrl || ""
  });

  // Collapse the whitespace that empty placeholders leave behind, then swap
  // typographic characters that would silently force UCS-2.
  const body = toGsm7Safe(raw).replace(/[ \t]{2,}/g, " ").trim();
  return { body, ...analyzeMessage(body) };
}

/**
 * Decides whether an entry should get a warranty text, without sending.
 * Returns { eligible, reason } where reason is an SmsMessage.skipReason.
 */
export function evaluateEligibility(entry, smsSettings, { ignoreSuppression = false } = {}) {
  // Checked first: the owner ticking the box on the record is the most specific
  // answer to "why didn't this customer get a text?", so it should be the
  // reason that gets logged even when something else would also have stopped it.
  if (entry.suppressSms && !ignoreSuppression) return { eligible: false, reason: "suppressed" };

  if (!smsSettings?.enabled) return { eligible: false, reason: "disabled" };

  const types = smsSettings.entryTypes?.length ? smsSettings.entryTypes : ["Repair"];
  if (!types.includes(entry.type)) return { eligible: false, reason: "ineligible-type" };

  if (!entry.customerPhone) return { eligible: false, reason: "no-phone" };
  if (!toE164US(entry.customerPhone)) return { eligible: false, reason: "unparseable-phone" };

  // A dry run still needs a sending number and template to render anything
  // meaningful, but it deliberately does not require carrier credentials.
  if (!smsSettings.dryRun) {
    if (!smsSettings.fromNumber || !isProviderConfigured(smsSettings.provider)) {
      return { eligible: false, reason: "not-configured" };
    }
  }

  return { eligible: true, reason: "" };
}

/**
 * Sends the warranty text for one entry, at most once, ever.
 *
 * Idempotency is claim-then-send: the log row is inserted *before* the carrier
 * call, so two concurrent saves race on a unique index instead of both texting
 * the customer. A duplicate key means someone else already handled this entry.
 *
 * Never throws — a carrier outage must not fail the record save that triggered
 * it. Failures are recorded and surfaced in the UI instead.
 */
export async function sendWarrantySms(accountId, entry, smsSettings, options = {}) {
  const kind = "warranty";
  // ignoreSuppression is the manual-resend escape hatch: an owner who clicks
  // Resend on a record they had earlier marked "don't text" has just overruled
  // themselves, and silently skipping would look like the button was broken.
  const { eligible, reason } = evaluateEligibility(entry, smsSettings, {
    ignoreSuppression: options.ignoreSuppression === true
  });

  // Opt-out is checked before claiming so a STOP customer doesn't get a claim
  // row that would block a legitimate resend if they later opt back in.
  if (eligible) {
    const phoneKey = normalizePhoneKey(entry.customerPhone);
    const optedOut = await SmsOptOut.findOne({ accountId, phoneKey }).lean();
    if (optedOut) {
      return recordAttempt(accountId, entry, { kind, status: "skipped", skipReason: "opted-out" });
    }
  }

  if (!eligible) {
    return recordAttempt(accountId, entry, { kind, status: "skipped", skipReason: reason });
  }

  const { body, segments, encoding } = buildWarrantyMessage(entry, smsSettings);
  const to = toE164US(entry.customerPhone);

  // Claim the entry. If this throws a duplicate key, the text already went out.
  let claim;
  try {
    claim = await SmsMessage.create({
      accountId,
      entryId: entry._id,
      kind,
      status: smsSettings.dryRun ? "dry-run" : "failed",
      toNumber: to,
      body,
      segments,
      encoding,
      provider: smsSettings.dryRun ? "dry-run" : smsSettings.provider
    });
  } catch (error) {
    if (error?.code === 11000) {
      return { status: "already-sent", skipped: true };
    }
    throw error;
  }

  if (smsSettings.dryRun) {
    claim.sentAt = new Date();
    await claim.save();
    return { status: "dry-run", body, segments, encoding };
  }

  try {
    const { providerMessageId } = await sendSms(
      { to, from: smsSettings.fromNumber, body, provider: smsSettings.provider },
      options
    );
    claim.status = "sent";
    claim.providerMessageId = providerMessageId;
    claim.sentAt = new Date();
    await claim.save();
    return { status: "sent", body, segments, encoding, providerMessageId };
  } catch (error) {
    claim.status = "failed";
    claim.error = String(error?.message || error).slice(0, 500);
    await claim.save();
    return { status: "failed", error: claim.error };
  }
}

async function recordAttempt(accountId, entry, fields) {
  try {
    const doc = await SmsMessage.create({ accountId, entryId: entry._id, ...fields });
    return { status: doc.status, skipReason: doc.skipReason, skipped: true };
  } catch (error) {
    if (error?.code === 11000) return { status: "already-sent", skipped: true };
    throw error;
  }
}

/** Clears the log row so a failed or skipped send can be retried. */
export async function clearWarrantyAttempt(accountId, entryId, kind = "warranty") {
  await SmsMessage.deleteOne({ accountId, entryId, kind });
}
