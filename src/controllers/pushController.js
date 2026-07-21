import { PushSubscription } from "../models/PushSubscription.js";
import { asyncHandler } from "../utils.js";

// GET /api/push/vapid-public-key — lets the PWA fetch the public key at runtime
// instead of baking it in at build time (both are supported).
export const vapidPublicKey = asyncHandler(async (_req, res) => {
  return res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || "" });
});

// POST /api/push/subscribe — upsert a device's Web Push subscription.
export const subscribe = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const endpoint = String(body.endpoint || "").trim();
  const p256dh = body?.keys?.p256dh;
  const auth = body?.keys?.auth;

  if (!endpoint || !p256dh || !auth) {
    return res.status(400).json({ message: "A valid push subscription is required." });
  }

  // Scoped on endpoint + accountId so re-subscribing the same browser under a
  // different account re-points it rather than silently updating another
  // account's row.
  await PushSubscription.findOneAndUpdate(
    { endpoint, accountId: req.accountId },
    {
      accountId: req.accountId,
      endpoint,
      keys: { p256dh, auth },
      userAgent: String(body.userAgent || req.get("user-agent") || "").slice(0, 300)
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  return res.status(201).json({ ok: true });
});

// POST /api/push/unsubscribe — remove a device's subscription.
export const unsubscribe = asyncHandler(async (req, res) => {
  const endpoint = String(req.body?.endpoint || "").trim();
  if (!endpoint) {
    return res.status(400).json({ message: "endpoint is required." });
  }

  await PushSubscription.deleteOne({ endpoint, accountId: req.accountId });
  return res.json({ ok: true });
});
