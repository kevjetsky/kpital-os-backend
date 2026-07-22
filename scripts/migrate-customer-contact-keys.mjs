import "dotenv/config";
import mongoose from "mongoose";
import { ReferenceOption } from "../src/models/ReferenceOption.js";
import { normalizePhoneKey, normalizeInstagramHandle } from "../src/utils.js";

if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

await mongoose.connect(process.env.MONGODB_URI);
try {
  const customers = await ReferenceOption.find({ kind: "customer" })
    .setOptions({ allowCrossAccount: true });
  let updated = 0;
  for (const customer of customers) {
    const phoneKey = normalizePhoneKey(customer.phone);
    const instagramKey = normalizeInstagramHandle(customer.instagram);
    if (customer.phoneKey === phoneKey && customer.instagramKey === instagramKey) continue;
    customer.phoneKey = phoneKey;
    customer.instagramKey = instagramKey;
    await customer.save();
    updated += 1;
  }
  console.log(`Backfilled normalized contact keys for ${updated} customer(s).`);
} finally {
  await mongoose.disconnect();
}
