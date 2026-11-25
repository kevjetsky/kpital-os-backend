// MongoDB collections for online booking.
//
//  - bookinglocks: one document per arrival window that is held, being booked,
//    or was just booked. A unique index on (accountId, slotKey) is what makes
//    two customers unable to take the same time, across every server instance.
//    A lock expires: a hold after its 10 minutes, a booking after 5 minutes (by
//    then the Google Calendar event exists and the calendar decides).
//  - bookings: the booking records (customer details, calendar event id).
//  - bookingrequests: Idempotency-Key replays for POST /book, kept 24 hours.
//  - bookingcounters: rate-limit windows and the daily Routes allowance.
import mongoose from "mongoose";
import { tenantGuard } from "../models/tenantGuard.js";

const lockSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    // "2026-11-27T09:00" in Chicago time.
    slotKey: { type: String, required: true },
    date: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    kind: { type: String, enum: ["hold", "claimed", "booked"], required: true },
    expiresAt: { type: Date, required: true },
    area: {
      address: { type: String, default: "" },
      lat: { type: Number, default: null },
      lng: { type: Number, default: null },
      key: { type: String, default: "" }
    },
    bookingId: { type: String, default: "" }
  },
  { timestamps: true }
);
lockSchema.index({ accountId: 1, slotKey: 1 }, { unique: true });
lockSchema.index({ accountId: 1, date: 1 });
// Mongo removes expired locks within a minute or so; every read also ignores
// them, so nothing depends on how quickly that happens.
lockSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
tenantGuard(lockSchema, { modelName: "BookingLock" });

const bookingSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true },
    bookingId: { type: String, required: true },
    status: { type: String, enum: ["booked", "cancelled"], default: "booked" },
    date: { type: String, required: true },
    start: { type: Date, required: true },
    end: { type: Date, required: true },
    service: { type: String, required: true },
    serviceLabel: { type: String, required: true },
    device: { type: String, default: "" },
    issue: { type: String, default: "" },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    email: { type: String, default: "" },
    notes: { type: String, default: "" },
    address: { type: String, required: true },
    addressKey: { type: String, required: true },
    lat: { type: Number, default: null },
    lng: { type: Number, default: null },
    smsConsent: { type: Boolean, default: false },
    language: { type: String, enum: ["en", "es"], default: "en" },
    utm: {
      source: { type: String, default: "" },
      medium: { type: String, default: "" },
      campaign: { type: String, default: "" },
      referrer: { type: String, default: "" }
    },
    leadSource: { type: String, default: "direct" },
    calendarId: { type: String, default: "" },
    eventId: { type: String, default: "" },
    calendarLink: { type: String, default: "" },
    cancelledAt: { type: Date, default: null }
  },
  { timestamps: true }
);
bookingSchema.index({ accountId: 1, bookingId: 1 }, { unique: true });
bookingSchema.index({ accountId: 1, phone: 1, status: 1, start: 1 });
bookingSchema.index({ accountId: 1, addressKey: 1, date: 1, status: 1 });
bookingSchema.index({ accountId: 1, start: -1 });
tenantGuard(bookingSchema, { modelName: "Booking" });

const requestSchema = new mongoose.Schema({
  _id: { type: String },
  state: { type: String, enum: ["pending", "done"], required: true },
  result: { type: mongoose.Schema.Types.Mixed, default: null },
  createdAt: { type: Date, default: Date.now }
});
requestSchema.index({ createdAt: 1 }, { expireAfterSeconds: 24 * 3600 });

const counterSchema = new mongoose.Schema({
  _id: { type: String },
  count: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true }
});
counterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BookingLock = mongoose.models.BookingLock || mongoose.model("BookingLock", lockSchema);
export const Booking = mongoose.models.Booking || mongoose.model("Booking", bookingSchema);
export const BookingRequest = mongoose.models.BookingRequest || mongoose.model("BookingRequest", requestSchema);
export const BookingCounter = mongoose.models.BookingCounter || mongoose.model("BookingCounter", counterSchema);

// The unique slot index is what stops double booking, so booking routes wait
// until Mongo confirms the indexes exist (mongoose builds them in the
// background, and the first request could otherwise beat it). Retried on the
// next request if it failed.
let indexesReady = null;
export function bookingIndexesReady() {
  if (!indexesReady) {
    indexesReady = Promise.all([BookingLock.init(), Booking.init(), BookingRequest.init(), BookingCounter.init()]).catch((error) => {
      indexesReady = null;
      throw error;
    });
  }
  return indexesReady;
}
