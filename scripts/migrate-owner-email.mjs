// One-off migration: attach the owner's login email to the legacy settings
// document created before email+password auth existed.
//
// The email is marked verified because it is set directly by the owner, so no
// verification code needs to be delivered (Resend can't reach this address
// until a domain is verified there anyway).
//
// Usage (from backend/):  node --env-file=.env scripts/migrate-owner-email.mjs
// Safe to run more than once (idempotent). Refuses to overwrite a different
// existing email unless FORCE_EMAIL=1 is set.

import mongoose from "mongoose";
import { Settings } from "../src/models/Settings.js";

const OWNER_EMAIL = "kevin.gnzlz@kpitaltech.com";

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const settings = await Settings.findOne({ key: "main" });

  if (!settings) {
    console.error("No settings document found — nothing to migrate. Run initial setup instead.");
    await mongoose.connection.close();
    process.exit(1);
  }

  if (settings.email === OWNER_EMAIL && settings.emailVerified) {
    console.log("Already migrated: %s (verified). Nothing to do.", settings.email);
    await mongoose.connection.close();
    return;
  }

  if (settings.email && settings.email !== OWNER_EMAIL && process.env.FORCE_EMAIL !== "1") {
    console.error(
      "Settings already has a different email (%s). Set FORCE_EMAIL=1 to overwrite.",
      settings.email
    );
    await mongoose.connection.close();
    process.exit(1);
  }

  settings.email = OWNER_EMAIL;
  settings.emailVerified = true;
  settings.verificationCodeHash = "";
  settings.verificationCodeExpiresAt = null;
  settings.verificationAttempts = 0;
  await settings.save();

  console.log("Owner email set to %s (verified). Password unchanged.", OWNER_EMAIL);
  await mongoose.connection.close();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error("Migration failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
