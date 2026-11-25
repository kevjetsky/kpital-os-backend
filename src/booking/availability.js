// Which arrival windows fit a customer, day by day. This is the Slot Finder
// itself (findSlots): the owner's grid, buffer, home base and "home by" time,
// Google Calendar, jobs booked in Kpital OS, and traffic-aware drive times. The
// booking page adds only its own customer-facing policies on top:
//  - a minimum lead time (no booking a slot that starts in under 90 minutes);
//  - the day's last slot only when the drive home is short (20 minutes), done
//    through the Slot Finder's own "home by" rule;
//  - online holds and just-made bookings block their time too.
import { findSlots } from "../slotFinder/service.js";
import { listBookedJobEvents } from "../slotFinder/bookedJobs.js";
import { addMinutes, chicagoInstant, toChicagoRfc3339 } from "../slotFinder/time.js";
import { activeLocks } from "./store.js";

const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
};
const toHhmm = (minutes) => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

// "Home by": the owner's own limit if set, otherwise the end of the last slot
// plus the longest drive home the booking page allows. Whichever is earlier.
export function bookingHomeBy(settings, config) {
  const last = [...settings.slotStarts].sort().at(-1);
  const derived = toHhmm(toMinutes(last) + config.jobMinutes + config.lastSlotMaxDriveHomeMin);
  if (!settings.homeBy) return derived;
  // Times before 05:00 are after midnight (see the Slot Finder).
  const rank = (hhmm) => (hhmm < "05:00" ? toMinutes(hhmm) + 1440 : toMinutes(hhmm));
  return rank(settings.homeBy) <= rank(derived) ? settings.homeBy : derived;
}

// Online holds block their time; a just-made booking is also a stop on the route.
function lockEvents(locks, date) {
  return locks
    .filter((lock) => lock.date === date)
    .map((lock) => ({
      summary: lock.kind === "hold" ? "Online hold" : "Online booking",
      start: new Date(lock.start),
      end: new Date(lock.end),
      location: lock.kind === "hold" ? "" : lock.area?.address || "",
      status: "confirmed",
      allDay: false
    }));
}

/**
 * Map of date -> [{ start: "HH:MM", at: Date, recommended }] for the customer at
 * `address`, checking the dates one after another so drive times repeat from
 * the cache.
 */
export async function offeredByDate({ dates, address, accountId, settings, config, now, drive, exceptHoldId = null }) {
  const locks = await activeLocks(accountId, dates, now, { exceptHoldId });
  const homeBy = bookingHomeBy(settings, config);
  const earliest = addMinutes(now, config.minLeadMinutes);
  const out = new Map();
  for (const date of dates) {
    const slotStarts = settings.slotStarts.filter((start) => chicagoInstant(date, start) >= earliest);
    if (slotStarts.length === 0) {
      out.set(date, []);
      continue;
    }
    const result = await findSlots(
      { date, address, durationMinutes: config.jobMinutes, settings: { ...settings, slotStarts, homeBy }, now },
      {
        getDriveMatrix: drive,
        fetchBookedJobs: async (day) => [...(await listBookedJobEvents(accountId, day)), ...lockEvents(locks, day)],
        // The Slot Finder's "nearby booking" hint is for the owner, not the customer.
        locate: async () => null
      }
    );
    out.set(
      date,
      result.slots.map((slot) => ({ start: slot.start, at: chicagoInstant(date, slot.start), recommended: slot.recommended }))
    );
  }
  return out;
}

export const publicSlots = (slots) => slots.map((slot) => ({ start: toChicagoRfc3339(slot.at), recommended: slot.recommended }));
