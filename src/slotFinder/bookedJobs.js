// Jobs booked in Kpital OS with a time on them, as Slot Finder events.
//
// The Slot Finder reads Google Calendar, but a job booked straight into the
// app holds its time just the same. These are added to the calendar's events
// so a slot is never offered on top of one. A job that is also on the calendar
// simply appears twice at the same time and place, which changes nothing.
import { Entry } from "../models/Entry.js";
import { addMinutes, chicagoInstant } from "./time.js";

const DEFAULT_JOB_MINUTES = 60;
// Work already finished no longer needs its place in the day.
const OPEN_JOB_STATUSES = ["Booked", "In progress"];

export async function listBookedJobEvents(accountId, date) {
  const jobs = await Entry.find({
    accountId,
    date: new Date(`${date}T00:00:00.000Z`),
    type: { $in: ["Repair", "Sales"] },
    scheduledTime: { $gt: "" },
    jobStatus: { $in: OPEN_JOB_STATUSES }
  })
    .select("scheduledTime scheduledMinutes customerAddress customerName description items")
    .lean();

  return jobs.map((job) => {
    const start = chicagoInstant(date, job.scheduledTime);
    return {
      summary: job.description || job.items?.[0]?.name || job.customerName || "Job",
      start,
      end: addMinutes(start, job.scheduledMinutes || DEFAULT_JOB_MINUTES),
      location: String(job.customerAddress || "").trim(),
      status: "confirmed",
      allDay: false
    };
  });
}
