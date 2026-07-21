import { asyncHandler, getAccountById } from "../utils.js";
import { runNotifications } from "../services/notificationRunner.js";

const PREF_KEYS = ["lowStock", "quarterlyTax", "recurringPosted", "weeklySummary"];

// POST /api/notifications/cron/run — evaluates notification triggers. Called by
// the Cloudflare cron (shared secret), same as the recurring cron.
export const runDue = asyncHandler(async (_req, res) => {
  const results = await runNotifications(new Date());
  return res.json({ ok: true, results });
});

// GET /api/notifications/prefs
export const getPrefs = asyncHandler(async (req, res) => {
  const settings = await getAccountById(req.accountId);
  const prefs = settings?.notificationPrefs || {};
  return res.json({
    lowStock: prefs.lowStock !== false,
    quarterlyTax: prefs.quarterlyTax !== false,
    recurringPosted: prefs.recurringPosted !== false,
    weeklySummary: prefs.weeklySummary !== false
  });
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

  return res.json({
    lowStock: settings.notificationPrefs.lowStock !== false,
    quarterlyTax: settings.notificationPrefs.quarterlyTax !== false,
    recurringPosted: settings.notificationPrefs.recurringPosted !== false,
    weeklySummary: settings.notificationPrefs.weeklySummary !== false
  });
});
