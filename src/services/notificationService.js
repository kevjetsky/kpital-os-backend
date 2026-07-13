import webpush from "web-push";
import { PushSubscription } from "../models/PushSubscription.js";

let configured = false;

// Configure web-push lazily from env. Returns false if VAPID keys are missing so
// callers can no-op gracefully in environments where push isn't set up.
function ensureConfigured() {
  if (configured) return true;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT || "mailto:kevjetsky@gmail.com";
  if (!publicKey || !privateKey) {
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

export function isPushConfigured() {
  return ensureConfigured();
}

// Send one notification to every subscribed device. Dead subscriptions
// (404/410) are pruned. Returns { sent, pruned }.
export async function sendToAll({ title, body, url = "/", tag }) {
  if (!ensureConfigured()) {
    return { sent: 0, pruned: 0, skipped: "vapid-not-configured" };
  }

  const subscriptions = await PushSubscription.find().lean();
  if (subscriptions.length === 0) {
    return { sent: 0, pruned: 0 };
  }

  const payload = JSON.stringify({ title, body, url, tag: tag || title });
  let sent = 0;
  const deadIds = [];

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          payload
        );
        sent += 1;
      } catch (err) {
        const status = err?.statusCode;
        if (status === 404 || status === 410) {
          deadIds.push(sub._id);
        } else {
          console.error("Push send failed:", status, err?.body || err?.message || err);
        }
      }
    })
  );

  if (deadIds.length > 0) {
    await PushSubscription.deleteMany({ _id: { $in: deadIds } });
  }

  return { sent, pruned: deadIds.length };
}
