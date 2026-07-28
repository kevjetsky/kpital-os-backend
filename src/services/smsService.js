// Provider-agnostic SMS sending.
//
// The provider is a config value rather than a hard dependency because the
// cheapest carrier today is not necessarily the cheapest one next year, and
// switching should be a settings change rather than a rewrite. Every adapter
// takes { to, from, body } and returns { providerMessageId }, or throws.

// The GSM-7 basic set plus its extension table. Anything outside this forces the
// whole message into UCS-2.
const GSM7_BASIC =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
// These cost two GSM-7 characters each (escape + character).
const GSM7_EXTENDED = "^{}\\[~]|€";

const GSM7_BASIC_SET = new Set(GSM7_BASIC);
const GSM7_EXTENDED_SET = new Set(GSM7_EXTENDED);

/**
 * Works out how a body will actually be billed.
 *
 * This matters more than it looks: a single curly quote, en dash, or emoji —
 * the kind of character a phone keyboard inserts without asking — pushes the
 * message from GSM-7 (160 chars per segment) to UCS-2 (70 chars per segment).
 * A 150-character message that was one segment silently becomes three, and the
 * bill triples with no visible change to the text.
 */
export function analyzeMessage(body) {
  const text = String(body ?? "");

  let gsmUnits = 0;
  let gsmSafe = true;
  const offenders = new Set();

  for (const char of text) {
    if (GSM7_BASIC_SET.has(char)) {
      gsmUnits += 1;
    } else if (GSM7_EXTENDED_SET.has(char)) {
      gsmUnits += 2;
    } else {
      gsmSafe = false;
      offenders.add(char);
    }
  }

  if (gsmSafe) {
    // Single-segment GSM-7 holds 160; concatenated parts lose 7 to the header.
    const segments = gsmUnits === 0 ? 1 : gsmUnits <= 160 ? 1 : Math.ceil(gsmUnits / 153);
    return { encoding: "GSM-7", length: gsmUnits, segments, offenders: [] };
  }

  // UCS-2 counts UTF-16 code units, so astral characters (emoji) cost 2.
  const units = text.length;
  const segments = units === 0 ? 1 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: "UCS-2", length: units, segments, offenders: [...offenders] };
}

/** Swaps the usual typographic culprits for GSM-7 equivalents. */
export function toGsm7Safe(body) {
  return String(body ?? "")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[–—−]/g, "-")
    .replace(/…/g, "...")
    .replace(/ /g, " ")
    .replace(/•/g, "*");
}

async function sendViaTelnyx({ to, from, body }, { apiKey, messagingProfileId, fetchImpl }) {
  const response = await fetchImpl("https://api.telnyx.com/v2/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      to,
      from,
      text: body,
      ...(messagingProfileId ? { messaging_profile_id: messagingProfileId } : {})
    })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.errors?.[0]?.detail || payload?.message || `HTTP ${response.status}`;
    throw new Error(`Telnyx rejected the message (${detail}).`);
  }
  return { providerMessageId: payload?.data?.id || "" };
}

async function sendViaTwilio({ to, from, body }, { accountSid, authToken, fetchImpl }) {
  const form = new URLSearchParams({ To: to, From: from, Body: body });
  const response = await fetchImpl(
    `https://api.twilio.com/2010-04-01/Accounts/${accountSid}/Messages.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`
      },
      body: form.toString()
    }
  );

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = payload?.message || `HTTP ${response.status}`;
    throw new Error(`Twilio rejected the message (${detail}).`);
  }
  return { providerMessageId: payload?.sid || "" };
}

/**
 * Reports whether credentials for a provider are present, without revealing
 * them. Used to fail a send closed rather than half-configured.
 */
export function isProviderConfigured(provider, env = process.env) {
  if (provider === "telnyx") return Boolean(env.TELNYX_API_KEY);
  if (provider === "twilio") return Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN);
  if (provider === "noop") return true;
  return false;
}

/**
 * Hands one message to the configured carrier.
 *
 * Callers are expected to have already decided the message *should* go out;
 * this does not check opt-out or eligibility.
 */
export async function sendSms({ to, from, body, provider }, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;

  if (!to) throw new Error("sendSms requires a destination number.");
  if (!from) throw new Error("sendSms requires a sending number.");
  if (!body) throw new Error("sendSms requires a message body.");

  if (provider === "noop") {
    return { providerMessageId: "" };
  }

  if (provider === "telnyx") {
    return sendViaTelnyx(
      { to, from, body },
      {
        apiKey: env.TELNYX_API_KEY,
        messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID,
        fetchImpl
      }
    );
  }

  if (provider === "twilio") {
    return sendViaTwilio(
      { to, from, body },
      { accountSid: env.TWILIO_ACCOUNT_SID, authToken: env.TWILIO_AUTH_TOKEN, fetchImpl }
    );
  }

  throw new Error(`Unknown SMS provider "${provider}".`);
}
