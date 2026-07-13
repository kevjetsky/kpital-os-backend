import mongoose from "mongoose";

// A Web Push subscription for one of the owner's devices/browsers. Created when
// they enable notifications from the PWA; pruned automatically when the push
// service reports the endpoint is gone (404/410).
const pushSubscriptionSchema = new mongoose.Schema(
  {
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true }
    },
    userAgent: { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

export const PushSubscription = mongoose.model("PushSubscription", pushSubscriptionSchema);
