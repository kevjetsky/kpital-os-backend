import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

// A Web Push subscription for one of the owner's devices/browsers. Created when
// they enable notifications from the PWA; pruned automatically when the push
// service reports the endpoint is gone (404/410).
const pushSubscriptionSchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Scopes which business's notifications
    // this device receives. `endpoint` stays globally unique because a push
    // endpoint identifies one browser install and cannot belong to two accounts.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },
    userAgent: { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

tenantGuard(pushSubscriptionSchema, { modelName: "PushSubscription" });

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
