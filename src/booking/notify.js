// What happens after a booking: the owner hears about it (a push notification
// to their Kpital OS devices and an email to their login address), and the
// customer gets a confirmation email when they gave one.
//
// The owner email uses the backend's Resend sender (RESEND_FROM_EMAIL). The
// customer email goes out only once BOOKING_EMAIL_FROM is set to a sender on a
// We-Fix-Consoles domain verified in Resend, so customers never get mail from
// "Kpital OS". Customer SMS waits for sent.dm approval; its copy is logged.
// Nothing here can fail a booking.
import { Settings } from "../models/Settings.js";
import { sendToAccount } from "../services/notificationService.js";
import { TIME_ZONE } from "../slotFinder/time.js";

const RESEND_URL = "https://api.resend.com/emails";

const escapeHtml = (text) =>
  String(text ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

export function maskPhone(phone) {
  const digits = String(phone || "").replace(/\D/g, "");
  return digits.length >= 4 ? `***${digits.slice(-4)}` : "***";
}

// "+13466674364" -> "(346) 667-4364"
export function prettyPhone(e164) {
  const digits = String(e164 || "").replace(/\D/g, "").replace(/^1/, "");
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : String(e164 || "");
}

const mapsLink = (address) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
const clock = (at) =>
  new Intl.DateTimeFormat("en-US", { timeZone: TIME_ZONE, hour: "numeric", minute: "2-digit" }).format(new Date(at)).replace(/\u202f/g, " ");

// "Tue Nov 24, 3:00 PM" / "mar 24 nov, 3:00 PM"
export function whenLabel(start, language = "en") {
  const at = new Date(start);
  const locale = language === "es" ? "es-US" : "en-US";
  const part = (options) => new Intl.DateTimeFormat(locale, { timeZone: TIME_ZONE, ...options }).format(at).replace(/\.$/, "");
  const day =
    language === "es"
      ? `${part({ weekday: "short" })} ${part({ day: "numeric" })} ${part({ month: "short" })}`
      : `${part({ weekday: "short" })} ${part({ month: "short" })} ${part({ day: "numeric" })}`;
  return `${day}, ${clock(at)}`;
}

function windowLabel(start, end) {
  const [from, to] = [clock(start), clock(end)];
  return { start: from.slice(-2) === to.slice(-2) ? from.replace(/ (AM|PM)$/, "") : from, end: to };
}

export function ownerEmail(booking, config) {
  const when = whenLabel(booking.start);
  const subject = `${config.emailSubjectPrefix}New booking: ${when} - ${booking.serviceLabel}`;
  const lines = [
    `When: ${when}`,
    `Service: ${booking.serviceLabel}`,
    ...(booking.issue ? [`What's wrong: ${booking.issue}`] : []),
    `Device: ${booking.device}`,
    `Customer: ${booking.name}`,
    `Phone: ${prettyPhone(booking.phone)} (tel:${booking.phone})`,
    `Address: ${booking.address}`,
    `Map: ${mapsLink(booking.address)}`,
    booking.email ? `Email: ${booking.email}` : null,
    `Notes: ${booking.notes || "none"}`,
    `Lead source: ${booking.leadSource}`,
    `SMS consent: ${booking.smsConsent ? "yes" : "no"}`,
    booking.calendarLink ? `Calendar: ${booking.calendarLink}` : null,
    `Booking ID: ${booking.bookingId}`
  ].filter(Boolean);
  const row = (label, value) => `<tr><td style="padding:4px 12px 4px 0;color:#4c669a">${label}</td><td style="padding:4px 0">${value}</td></tr>`;
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;color:#0d121b">
<p style="font-size:17px;margin:0 0 12px"><strong>${escapeHtml(when)}</strong> - ${escapeHtml(booking.serviceLabel)}</p>
<table style="border-collapse:collapse">
${row("Device", escapeHtml(booking.device))}
${row("Customer", escapeHtml(booking.name))}
${row("Phone", `<a href="tel:${escapeHtml(booking.phone)}">${escapeHtml(prettyPhone(booking.phone))}</a>`)}
${row("Address", `<a href="${escapeHtml(mapsLink(booking.address))}">${escapeHtml(booking.address)}</a>`)}
${booking.issue ? row("What's wrong", escapeHtml(booking.issue)) : ""}
${booking.email ? row("Email", escapeHtml(booking.email)) : ""}
${row("Notes", escapeHtml(booking.notes || "none"))}
${row("Lead source", escapeHtml(booking.leadSource))}
${row("SMS consent", booking.smsConsent ? "yes" : "no")}
${booking.calendarLink ? row("Calendar", `<a href="${escapeHtml(booking.calendarLink)}">Open event</a>`) : ""}
${row("Booking ID", escapeHtml(booking.bookingId))}
</table></div>`;
  return { subject, text: lines.join("\n"), html };
}

// RFC 5545 calendar file for the customer.
export function buildIcs(booking, config) {
  const stamp = (at) => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const fold = (text) => String(text).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//We-Fix-Consoles//Booking//EN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${booking.bookingId}@we-fix-consoles.com`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(booking.start)}`,
    `DTEND:${stamp(booking.end)}`,
    `SUMMARY:${fold(`We-Fix-Consoles: ${booking.serviceLabel}`)}`,
    `LOCATION:${fold(booking.address)}`,
    `DESCRIPTION:${fold(`${booking.device} - ${booking.serviceLabel}. Questions? Text ${prettyPhone(config.businessPhone)}. Booking ${booking.bookingId}`)}`,
    "END:VEVENT",
    "END:VCALENDAR",
    ""
  ].join("\r\n");
}

export function customerEmail(booking, config) {
  const es = booking.language === "es";
  const when = whenLabel(booking.start, booking.language);
  const win = windowLabel(booking.start, booking.end);
  const day = when.split(",")[0];
  const subject = es ? `Cita confirmada: ${when}` : `Booking confirmed: ${when}`;
  const text = es
    ? `Su cita con We-Fix-Consoles está confirmada.\n\nLlegada: entre ${win.start} y ${win.end}, ${day}\nServicio: ${booking.serviceLabel}\nEquipo: ${booking.device}\nDirección: ${booking.address}\n\n¿Preguntas o cambios? Escríbanos un mensaje al ${prettyPhone(config.businessPhone)}.\nReserva ${booking.bookingId}`
    : `Your We-Fix-Consoles visit is booked.\n\nArriving: between ${win.start} and ${win.end}, ${day}\nService: ${booking.serviceLabel}\nDevice: ${booking.device}\nAddress: ${booking.address}\n\nQuestions or changes? Text us at ${prettyPhone(config.businessPhone)}.\nBooking ${booking.bookingId}`;
  return { subject, text, html: `<pre style="font-family:system-ui,sans-serif;font-size:15px;white-space:pre-wrap">${escapeHtml(text)}</pre>` };
}

export function customerSms(booking, config) {
  const win = windowLabel(booking.start, booking.end);
  const day = whenLabel(booking.start, booking.language).split(",")[0];
  return booking.language === "es"
    ? `We-Fix-Consoles: su cita está confirmada para ${day}, llegando entre ${win.start} y ${win.end}. Servicio: ${booking.serviceLabel}. ¿Preguntas? Escríbanos al ${prettyPhone(config.businessPhone)}. Responda STOP para no recibir mensajes.`
    : `We-Fix-Consoles: you're booked for ${day}, arriving between ${win.start} and ${win.end}. Service: ${booking.serviceLabel}. Questions? Text ${prettyPhone(config.businessPhone)}. Reply STOP to opt out.`;
}

async function sendResend(payload) {
  const response = await fetch(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw Object.assign(new Error(`Resend answered ${response.status}`), { status: response.status });
  return true;
}

// A refusal (4xx, e.g. Resend's test sender writing to another address) is not
// retried; it would only be refused again. Network errors, 429 and 5xx are.
const retryable = (error) => !(error?.status >= 400 && error.status < 500 && error.status !== 429);

async function withRetry(label, fn) {
  try {
    return await fn();
  } catch (first) {
    if (!retryable(first)) {
      console.error(JSON.stringify({ event: "booking_notify_failed", label, error: String(first?.message || first) }));
      return false;
    }
    console.warn(JSON.stringify({ event: "booking_notify_retry", label, error: String(first?.message || first) }));
    try {
      return await fn();
    } catch (second) {
      console.error(JSON.stringify({ event: "booking_notify_failed", label, error: String(second?.message || second) }));
      return false;
    }
  }
}

async function ownerAddress(accountId) {
  const account = await Settings.findById(accountId).select("email").lean();
  return String(account?.email || "").trim();
}

// Sends everything for one booking and says what happened. Never throws.
export async function notifyBooking(booking, config) {
  const results = {};
  const resend = Boolean(String(process.env.RESEND_API_KEY || "").trim());

  results.push = await sendToAccount(config.ownerAccountId, {
    title: `New booking: ${whenLabel(booking.start)}`,
    body: `${booking.serviceLabel} · ${booking.device} · ${booking.address}`,
    url: "/",
    tag: `booking-${booking.bookingId}`
  })
    .then((sent) => sent.sent > 0)
    .catch((error) => {
      console.error(JSON.stringify({ event: "booking_notify_failed", label: "owner_push", error: String(error?.message || error) }));
      return false;
    });

  const owner = ownerEmail(booking, config);
  const to = await ownerAddress(config.ownerAccountId).catch(() => "");
  if (resend && to) {
    const from = process.env.RESEND_FROM_EMAIL || "Kpital OS <onboarding@resend.dev>";
    results.ownerEmail = await withRetry("owner_email", () => sendResend({ from, to: [to], subject: owner.subject, text: owner.text, html: owner.html }));
  } else {
    console.log(JSON.stringify({ event: "booking_owner_email_logged", reason: resend ? "owner has no email" : "no RESEND_API_KEY", subject: owner.subject }));
    results.ownerEmail = "logged";
  }

  const customerFrom = String(process.env.BOOKING_EMAIL_FROM || "").trim();
  if (booking.email) {
    const mail = customerEmail(booking, config);
    if (resend && customerFrom) {
      const ics = Buffer.from(buildIcs(booking, config)).toString("base64");
      results.customerEmail = await withRetry("customer_email", () =>
        sendResend({
          from: customerFrom,
          to: [booking.email],
          subject: mail.subject,
          text: mail.text,
          html: mail.html,
          attachments: [{ filename: "we-fix-consoles.ics", content: ics }]
        })
      );
    } else {
      console.log(JSON.stringify({ event: "booking_customer_email_logged", reason: "BOOKING_EMAIL_FROM not set", subject: mail.subject }));
      results.customerEmail = "logged";
    }
  }

  if (booking.smsConsent) {
    console.log(JSON.stringify({ event: "booking_customer_sms_logged", reason: "sent.dm not wired yet", to: maskPhone(booking.phone), body: customerSms(booking, config) }));
    results.sms = "logged";
  }
  return results;
}
