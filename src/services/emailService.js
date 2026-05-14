function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDate(date) {
  const parsed = new Date(`${date}T00:00:00`);
  if (Number.isNaN(parsed.getTime())) return date;
  return parsed.toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
}

function formatSlotTime(time) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(time || ""));
  if (!match) return time;
  const hour = Number(match[1]);
  return `${hour % 12 || 12}:${match[2]}${hour >= 12 ? "pm" : "am"}`;
}

export async function sendAppointmentConfirmation(appointment) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL || "Kpital OS <onboarding@resend.dev>";
  const to = String(appointment.customerEmail || "").trim();

  if (!apiKey || !to) {
    return { sent: false, skipped: !apiKey ? "missing_api_key" : "missing_email" };
  }

  const appointmentTime = `${formatDate(appointment.appointmentDate)} at ${formatSlotTime(appointment.startTime)}`;
  const html = `
    <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827">
      <h2 style="margin:0 0 12px">Appointment confirmed</h2>
      <p>Hi ${escapeHtml(appointment.customerName)},</p>
      <p>Your appointment has been confirmed for <strong>${escapeHtml(appointmentTime)}</strong>.</p>
      <p><strong>Device:</strong> ${escapeHtml(appointment.deviceType)}</p>
      <p><strong>Issue:</strong> ${escapeHtml(appointment.issueDescription)}</p>
      <p>If you need to change anything, reply to this email or contact us directly.</p>
    </div>
  `;

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from,
      to: [to],
      subject: `Appointment confirmed: ${appointmentTime}`,
      html
    })
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(body?.message || "Failed to send confirmation email.");
  }

  return { sent: true, id: body?.id || "" };
}
