import { asyncHandler, getAccountById } from "../utils.js";
import { runNotifications } from "../services/notificationRunner.js";

const PREF_KEYS = ["lowStock", "quarterlyTax", "recurringPosted", "weeklySummary", "certExpiry", "overdueInvoices"];

// Every notification is on unless it was switched off, including ones added
// after the account's settings were first saved.
function serializePrefs(prefs = {}) {
  return Object.fromEntries(PREF_KEYS.map((key) => [key, prefs[key] !== false]));
}

// POST /api/notifications/cron/run — evaluates notification triggers. Called by
// the Cloudflare cron (shared secret), same as the recurring cron.
export const runDue = asyncHandler(async (_req, res) => {
  const results = await runNotifications(new Date());
  return res.json({ ok: true, results });
});

// GET /api/notifications/prefs
export const getPrefs = asyncHandler(async (req, res) => {
  const settings = await getAccountById(req.accountId);
  return res.json(serializePrefs(settings?.notificationPrefs));
});

// PUT /api/notifications/prefs — toggle which notifications the owner wants.
export const updatePrefs = asyncHandler(async (req, res) => {
  const settings = await getAccountById(req.accountId);
  if (!settings) {
    return res.status(404).json({ message: "Settings not initialized." });
  }

  const body = req.body ?? {};
  settings.notificationPrefs = settings.notificationPrefs || {};
  for (const key of PREF_KEYS) {
    if (Object.prototype.hasOwnProperty.call(body, key)) {
      settings.notificationPrefs[key] = Boolean(body[key]);
    }
  }
  await settings.save();

  return res.json(serializePrefs(settings.notificationPrefs));
});
