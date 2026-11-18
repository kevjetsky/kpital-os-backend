import { requireSharedSecret } from "./sharedSecret.js";

// Machine-to-machine auth for scheduled jobs (e.g. the Cloudflare cron trigger).
// Uses a shared secret header rather than the owner JWT. Secure by default: if
// CRON_SECRET is unset, every request is rejected.
export const requireCronSecret = requireSharedSecret({
  envName: "CRON_SECRET",
  header: "x-cron-secret",
  notConfigured: "Cron is not configured."
});
