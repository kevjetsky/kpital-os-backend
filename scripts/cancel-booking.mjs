// Cancel an online booking from the command line: removes its Google Calendar
// event, marks it cancelled and frees the time. The same as
// POST /api/bookings/:bookingId/cancel, for when no one is signed in.
//
//   node scripts/cancel-booking.mjs WFC-ABC123
//
// Needs MONGODB_URI, GOOGLE_CALENDAR_ACCOUNT_ID and the GOOGLE_CALENDAR_*
// variables of the deployment that took the booking.
import "dotenv/config";
import mongoose from "mongoose";
import { Booking, BookingLock } from "../src/booking/models.js";
import { deleteEvent } from "../src/services/googleCalendar.js";

const bookingId = String(process.argv[2] || "").trim();
if (!/^WFC-[A-Z2-9]{6}$/.test(bookingId)) {
  console.error("Usage: node scripts/cancel-booking.mjs WFC-XXXXXX");
  process.exit(1);
}
const accountId = String(process.env.GOOGLE_CALENDAR_ACCOUNT_ID || "").trim();
if (!accountId || !process.env.MONGODB_URI) {
  console.error("MONGODB_URI and GOOGLE_CALENDAR_ACCOUNT_ID are required.");
  process.exit(1);
}

await mongoose.connect(process.env.MONGODB_URI);
try {
  const booking = await Booking.findOne({ accountId, bookingId }).lean();
  if (!booking) {
    console.log(`${bookingId}: not found.`);
    process.exitCode = 1;
  } else if (booking.status === "cancelled") {
    console.log(`${bookingId}: already cancelled.`);
  } else {
    let calendar = "no event";
    if (booking.eventId) {
      await deleteEvent(booking.eventId, { calendarId: booking.calendarId });
      calendar = "event removed";
    }
    await Booking.updateOne({ accountId, bookingId }, { $set: { status: "cancelled", cancelledAt: new Date() } });
    await BookingLock.deleteOne({ accountId, bookingId });
    console.log(`${bookingId}: cancelled (${calendar}).`);
  }
} finally {
  await mongoose.disconnect();
}
