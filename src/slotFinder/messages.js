// Day labels and the customer messages the owner copies into a text.
import { addDays, formatSlotTime, weekdayOf } from "./time.js";

const EN_WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const EN_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const ES_WEEKDAYS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

// How each language names the queried day, by how far it is from today.
const DAY_WORDS = {
  en: {
    today: () => "today",
    tomorrow: () => "tomorrow",
    other: (date) => {
      const [, month, day] = date.split("-").map(Number);
      return `${EN_WEEKDAYS[weekdayOf(date)]}, ${EN_MONTHS[month - 1]} ${day}`;
    }
  },
  es: {
    today: () => "hoy",
    tomorrow: () => "mañana",
    other: (date) => `el ${ES_WEEKDAYS[weekdayOf(date)]}`
  }
};

function relativeDay(date, today) {
  if (date === today) return "today";
  if (date === addDays(today, 1)) return "tomorrow";
  return "other";
}

// "today", "tomorrow" or "Monday, Nov 9"; in Spanish "hoy", "mañana" or "el lunes".
export function dayLabel(date, today, language = "en") {
  return DAY_WORDS[language][relativeDay(date, today)](date);
}

// "11:00 AM, 3:00 PM, and 5:00 PM" / "11:00 AM, 3:00 PM y 5:00 PM".
export function joinTimes(times, language = "en") {
  if (times.length <= 1) return times.join("");
  const and = language === "es" ? "y" : "and";
  if (times.length === 2) return `${times[0]} ${and} ${times[1]}`;
  const head = times.slice(0, -1).join(", ");
  const last = times[times.length - 1];
  // English keeps the comma before "and"; Spanish never puts one before "y".
  return language === "es" ? `${head} ${and} ${last}` : `${head}, ${and} ${last}`;
}

// Fills {name} placeholders; unknown ones are left as written.
export function renderTemplate(template, values) {
  return String(template).replace(/\{([^{}]+)\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

// Both messages for the offered slot starts ("HH:MM"), or nulls when none.
export function buildMessages({ starts, date, today, templates }) {
  if (!starts.length) return { messageEn: null, messageEs: null };
  const times = starts.map(formatSlotTime);
  const one = times.length === 1;
  const esDay = dayLabel(date, today, "es");
  const en = { dayLabel: dayLabel(date, today, "en"), slot: times[0], slots: joinTimes(times, "en") };
  const es = { "día": esDay, dia: esDay, dayLabel: esDay, slot: times[0], slots: joinTimes(times, "es") };
  return {
    messageEn: renderTemplate(one ? templates.enOne : templates.enMany, en),
    messageEs: renderTemplate(one ? templates.esOne : templates.esMany, es)
  };
}
