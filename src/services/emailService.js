const RESEND_ENDPOINT = "https://api.resend.com/emails";

function getFromAddress() {
  return process.env.RESEND_FROM_EMAIL || "Kpital OS <onboarding@resend.dev>";
}

async function sendCodeEmail(to, code, { subject, heading, intro }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    throw new Error("RESEND_API_KEY is not configured.");
  }

  const response = await fetch(RESEND_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      from: getFromAddress(),
      to: [to],
      subject,
      html: [
        '<div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 420px; margin: 0 auto; padding: 24px;">',
        `<h2 style="margin: 0 0 8px;">${heading}</h2>`,
        `<p style="margin: 0 0 16px; color: #555;">${intro} It expires in 10 minutes.</p>`,
        `<p style="font-size: 32px; font-weight: 700; letter-spacing: 8px; margin: 0 0 16px;">${code}</p>`,
        '<p style="margin: 0; color: #999; font-size: 12px;">If you did not request this, you can ignore this email.</p>',
        "</div>"
      ].join(""),
      text: `${intro} Your code is ${code}. It expires in 10 minutes.`
    })
  });

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const detail = body?.message || `HTTP ${response.status}`;
    throw new Error(`Could not send email (${detail}).`);
  }
}

export async function sendVerificationEmail(to, code) {
  await sendCodeEmail(to, code, {
    subject: `${code} is your Kpital OS verification code`,
    heading: "Verify your email",
    intro: "Enter this code in Kpital OS to verify your email address."
  });
}

export async function sendPasswordResetEmail(to, code) {
  await sendCodeEmail(to, code, {
    subject: `${code} is your Kpital OS password reset code`,
    heading: "Reset your password",
    intro: "Enter this code in Kpital OS to set a new password."
  });
}
