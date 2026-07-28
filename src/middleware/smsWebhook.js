// Auth for carrier webhooks (inbound STOP replies).
//
// These arrive from Telnyx/Twilio, not from the owner's browser, so they cannot
// carry the owner JWT. A shared secret in a header is the same approach the
// cron trigger uses. Secure by default: with SMS_WEBHOOK_SECRET unset, every
// request is rejected rather than accepted.
//
// The account is named in the path because one deployment serves several
// businesses and an inbound message only tells us the phone numbers involved.
export function requireSmsWebhookSecret(req, res, next) {
  const expected = process.env.SMS_WEBHOOK_SECRET;
  if (!expected) {
    return res.status(503).json({ message: "SMS webhooks are not configured." });
  }

  const provided = req.get("x-sms-webhook-secret") || "";
  if (provided !== expected) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  return next();
}
