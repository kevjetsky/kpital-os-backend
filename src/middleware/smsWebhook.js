import { requireSharedSecret } from "./sharedSecret.js";

// Auth for carrier webhooks (inbound STOP replies).
//
// These arrive from Telnyx/Twilio, not from the owner's browser, so they cannot
// carry the owner JWT. A shared secret in a header is the same approach the
// cron trigger uses. Secure by default: with SMS_WEBHOOK_SECRET unset, every
// request is rejected rather than accepted.
//
// The account is named in the path because one deployment serves several
// businesses and an inbound message only tells us the phone numbers involved.
export const requireSmsWebhookSecret = requireSharedSecret({
  envName: "SMS_WEBHOOK_SECRET",
  header: "x-sms-webhook-secret",
  notConfigured: "SMS webhooks are not configured."
});
