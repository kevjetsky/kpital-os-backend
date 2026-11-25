// The owner's view of online bookings (signed in to Kpital OS):
//   GET  /api/bookings                      recent bookings, newest first
//   POST /api/bookings/:bookingId/cancel    cancel one: removes its Google
//                                           Calendar event and frees the time
// Only the business whose calendar takes the bookings (GOOGLE_CALENDAR_ACCOUNT_ID).
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { Booking, BookingLock } from "../booking/models.js";
import { deleteEvent } from "../services/googleCalendar.js";

const router = Router();
router.use(requireAuth);

router.use((req, res, next) => {
  const owner = String(process.env.GOOGLE_CALENDAR_ACCOUNT_ID || "").trim();
  if (!owner || owner !== String(req.accountId)) {
    return res.status(403).json({ message: "Online booking is not available on this account." });
  }
  return next();
});

router.get("/", async (req, res, next) => {
  try {
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
    const bookings = await Booking.find({ accountId: req.accountId }).sort({ start: -1 }).limit(limit).lean();
    res.set("Cache-Control", "no-store");
    res.json(bookings);
  } catch (error) {
    next(error);
  }
});

router.post("/:bookingId/cancel", async (req, res, next) => {
  try {
    const bookingId = String(req.params.bookingId || "");
    const booking = await Booking.findOne({ accountId: req.accountId, bookingId }).lean();
    if (!booking) return res.status(404).json({ message: "Booking not found." });
    if (booking.status === "cancelled") return res.json({ ok: true, calendarEvent: "none", alreadyCancelled: true });

    let calendarEvent = "none";
    if (booking.eventId) {
      calendarEvent = await deleteEvent(booking.eventId, { calendarId: booking.calendarId })
        .then(() => "deleted")
        .catch((error) => {
          console.error(JSON.stringify({ event: "booking_cancel_calendar_failed", bookingId, error: String(error?.message || error) }));
          return "delete_failed";
        });
    }
    await Booking.updateOne({ accountId: req.accountId, bookingId }, { $set: { status: "cancelled", cancelledAt: new Date() } });
    await BookingLock.deleteOne({ accountId: req.accountId, bookingId });
    res.json({ ok: true, calendarEvent });
  } catch (error) {
    next(error);
  }
});

export default router;
