// Slot Finder availability rules, against a mocked calendar feed and a stubbed
// getDriveMatrix keyed by from/to (departure times ignored unless a test checks
// them). Unless a test says otherwise, now is 06:00 America/Chicago on Friday
// 2026-11-06 and that date is queried; buffer 10, duration 60.
import { describe, it, expect } from "vitest";
import { findSlots, searchDays } from "../slotFinder/service.js";
import { defaultSlotFinderSettings, mergeWithDefaults } from "../slotFinder/settings.js";
import { buildMessages, dayLabel, joinTimes } from "../slotFinder/messages.js";
import { chicagoInstant, chicagoDateString, formatClock, toChicagoRfc3339 } from "../slotFinder/time.js";
import { dayWindow, normalizeEvents } from "../services/googleCalendar.js";
import { BAD_ADDRESS_MESSAGE, SlotFinderError } from "../slotFinder/errors.js";

const HOME = "11822 Bandlon Dr, Houston, TX 77072";
const PLACES = {
  [HOME]: "home",
  "2524 Chamberlain St, Pasadena, TX 77506": "pasadena",
  "23501 Cinco Ranch Blvd, Katy, TX 77494": "katy",
  "1 Katy Mills Cir, Katy, TX 77494": "katy2",
  "20131 Holzwarth Rd, Spring, TX 77388": "spring",
  "8800 Westheimer Rd, Houston, TX 77063": "westheimer",
  "999 Nowhere Rd, Atlantis, TX 00000": "nowhere"
};
const address = (name) => Object.keys(PLACES).find((key) => PLACES[key] === name);
const PASADENA = address("pasadena");
const KATY = address("katy");
const SPRING = address("spring");

const FRIDAY = "2026-11-06";
const at = (date, time) => chicagoInstant(date, time);
const NOW = at(FRIDAY, "06:00");

function timed(start, end, { date = FRIDAY, location = "", summary = "Job", ...rest } = {}) {
  return {
    summary,
    location,
    status: "confirmed",
    start: { dateTime: toChicagoRfc3339(at(date, start)), timeZone: "America/Chicago" },
    end: { dateTime: toChicagoRfc3339(at(date, end)), timeZone: "America/Chicago" },
    ...rest
  };
}

function allDay(startDate, endDate, extra = {}) {
  return { summary: "All day", status: "confirmed", start: { date: startDate }, end: { date: endDate }, ...extra };
}

// drives: { "katy>pasadena": 55 }; any pair not listed takes `fallback`.
// unreachable: ["home>nowhere"] etc.
async function run({
  items = [],
  drives = {},
  fallback = 30,
  unreachable = [],
  date = FRIDAY,
  now = NOW,
  customer = PASADENA,
  durationMinutes = 60,
  settings = defaultSlotFinderSettings()
} = {}) {
  const routeCalls = [];
  const calendarCalls = [];
  const result = await findSlots(
    { date, address: customer, durationMinutes, settings, now },
    {
      fetchCalendarItems: async (day) => {
        calendarCalls.push(day);
        return items;
      },
      getDriveMatrix: async (legs, options) => {
        routeCalls.push({ legs, options });
        return legs.map(({ from, to }) => {
          const key = `${PLACES[from] || from}>${PLACES[to] || to}`;
          if (unreachable.includes(key)) return { unreachable: true };
          return { minutes: drives[key] ?? fallback };
        });
      }
    }
  );
  return { result, routeCalls, calendarCalls, starts: result.slots.map((slot) => slot.start) };
}

const ALL = ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"];

describe("acceptance", () => {
  it("1. owner's worked example", async () => {
    const { result, starts, routeCalls } = await run({
      items: [
        timed("09:00", "10:00", { location: SPRING, summary: "PS5 HDMI" }),
        timed("11:00", "12:00", { location: KATY, summary: "Xbox cleaning" }),
        timed("15:00", "16:00", { location: KATY, summary: "PS4 thermal paste" })
      ],
      drives: { "katy>pasadena": 55, "pasadena>katy": 55 }
    });
    // 09, 11, 15 overlap; 13 fails both ways (13:05 > 13:00, 15:05 > 15:00);
    // 17 fails the drive in (17:05 > 17:00).
    expect(starts).toEqual(["19:00", "21:00"]);
    expect(result.state).toBe("ok");
    expect(result.slots[0]).toMatchObject({ start: "19:00", driveInMin: 55, driveOutMin: null, leaveHomeBy: null });
    expect(result.warnings).toEqual([]);

    // The 13:00 slot was judged on Katy (ended 12:00) in and Katy (15:00) out.
    const round1 = routeCalls[1].legs;
    expect(round1).toContainEqual({ from: KATY, to: PASADENA, departAt: at(FRIDAY, "12:00") });
    expect(round1).toContainEqual({ from: PASADENA, to: KATY, departAt: at(FRIDAY, "14:00") });
    expect(routeCalls.length).toBeLessThanOrEqual(3);
  });

  it("2. empty day: every slot, each with a leave-home-by", async () => {
    const { result, starts } = await run();
    expect(starts).toEqual(ALL);
    expect(result.slots.every((slot) => slot.leaveHomeBy && slot.driveOutMin === null)).toBe(true);
    expect(result.slots[0]).toMatchObject({ start: "09:00", driveInMin: 30, driveOutMin: null, leaveHomeBy: "8:20 AM" });
    expect(result.messageEn.startsWith("Hi, thanks for reaching out. For today I have availability at")).toBe(true);
    expect(result.messageEn).toBe(
      "Hi, thanks for reaching out. For today I have availability at 9:00 AM, 11:00 AM, 1:00 PM, 3:00 PM, 5:00 PM, 7:00 PM, and 9:00 PM. Which one works best for you? Once you pick, I will confirm the booking."
    );
  });

  it("3. fully blocked day", async () => {
    const { result, routeCalls } = await run({ items: [timed("08:00", "22:00", { location: KATY })] });
    expect(result).toMatchObject({ state: "no_slots", slots: [], messageEn: null, messageEs: null, warnings: [] });
    expect(routeCalls).toHaveLength(0);
  });

  it("4. unlocated event blocks its time but is never PREV", async () => {
    const { result, starts, routeCalls } = await run({
      items: [timed("11:00", "12:00", { location: KATY }), timed("13:00", "14:00", { summary: "Lunch" })],
      drives: { "home>pasadena": 30, "katy>pasadena": 40, "pasadena>katy": 40 }
    });
    expect(starts).not.toContain("13:00");
    const slot = result.slots.find((s) => s.start === "15:00");
    expect(slot).toMatchObject({ start: "15:00", driveInMin: 40, driveOutMin: null, leaveHomeBy: null });
    // PREV for 15:00 is the Katy job, departing when it ends.
    expect(routeCalls[1].legs).toContainEqual({ from: KATY, to: PASADENA, departAt: at(FRIDAY, "12:00") });
  });

  it("5. bad address", async () => {
    const error = await run({ unreachable: ["home>pasadena"] }).catch((e) => e);
    expect(error).toBeInstanceOf(SlotFinderError);
    expect(error.status).toBe(400);
    expect(error.message).toBe("Address not found or unreachable. Check the spelling and try again.");
    expect(BAD_ADDRESS_MESSAGE).toBe(error.message);
  });

  it("6. tomorrow label", async () => {
    const { result } = await run({ date: "2026-11-07" });
    expect(result.dayLabel).toBe("tomorrow");
    expect(result.messageEn).toContain("For tomorrow I have availability at");
    expect(result.messageEs).toContain("Para mañana tengo disponibilidad");
  });

  it("7. mid-day query drops slots that already started", async () => {
    const { starts } = await run({ now: at(FRIDAY, "15:30") });
    expect(starts).toEqual(["17:00", "19:00", "21:00"]);
  });

  it("8a. a transparent all-day event (birthday) is ignored", async () => {
    const { starts } = await run({ items: [allDay(FRIDAY, "2026-11-07", { summary: "Mom's birthday", transparency: "transparent" })] });
    expect(starts).toEqual(ALL);
  });

  it("8b. a busy all-day event blocks the day", async () => {
    const { result, routeCalls } = await run({ items: [allDay(FRIDAY, "2026-11-07", { summary: "Day off" })] });
    expect(result.state).toBe("no_slots");
    expect(routeCalls).toHaveLength(0);
  });

  it("8c. a declined event is ignored", async () => {
    const { starts } = await run({
      items: [timed("11:00", "12:00", { location: KATY, attendees: [{ email: "me@x.com", self: true, responseStatus: "declined" }] })]
    });
    expect(starts).toContain("11:00");
    expect(starts).toEqual(ALL);
  });

  it("9. a booking that cannot be routed is a time block only", async () => {
    const nowhere = address("nowhere");
    const { result, starts } = await run({
      items: [timed("11:00", "12:00", { location: nowhere, summary: "Fix PS5" })],
      unreachable: ["home>nowhere"]
    });
    expect(result.state).toBe("ok");
    expect(starts).not.toContain("11:00");
    expect(result.warnings).toContain("Could not route to the 11:00 AM booking (Fix PS5), so it was treated as a time block only.");
    const later = result.slots.find((slot) => slot.start === "13:00");
    expect(later.leaveHomeBy).toBe("12:20 PM");
    // Nor is it NEXT for the 09:00 slot.
    expect(result.slots.find((slot) => slot.start === "09:00").driveOutMin).toBeNull();
  });

  it("10. past date: no Google calls at all", async () => {
    const { result, routeCalls, calendarCalls } = await run({ date: "2026-11-05" });
    expect(result).toMatchObject({ state: "past_date", slots: [], messageEn: null, messageEs: null, warnings: [] });
    expect(routeCalls).toHaveLength(0);
    expect(calendarCalls).toHaveLength(0);
  });

  it("11. single slot and weekday labels", async () => {
    const { result, starts } = await run({ date: "2026-11-09", items: [timed("08:00", "20:00", { date: "2026-11-09", location: KATY })] });
    expect(starts).toEqual(["21:00"]);
    expect(result.dayLabel).toBe("Monday, Nov 9");
    expect(result.messageEn).toBe(
      "Hi, thanks for reaching out. For Monday, Nov 9 I have availability at 9:00 PM. Does that time work for you? Once you confirm, I will book it."
    );
    expect(result.messageEs).toBe(
      "Hola, gracias por escribir. Para el lunes tengo disponibilidad a las 9:00 PM. ¿Le funciona esa hora? Al confirmar, le agendo la cita."
    );
  });

  it("12. leave-home-by already past", async () => {
    const { result, starts } = await run({ now: at(FRIDAY, "15:30"), drives: { "home>pasadena": 100 } });
    expect(starts).toEqual(["19:00", "21:00"]);
    expect(result.slots[0]).toMatchObject({ start: "19:00", driveInMin: 100, driveOutMin: null, leaveHomeBy: "5:10 PM" });
  });

  it("13. message joining", () => {
    expect(joinTimes(["11:00 AM", "3:00 PM", "5:00 PM"], "en")).toBe("11:00 AM, 3:00 PM, and 5:00 PM");
    expect(joinTimes(["11:00 AM", "3:00 PM", "5:00 PM"], "es")).toBe("11:00 AM, 3:00 PM y 5:00 PM");
    expect(joinTimes(["11:00 AM", "5:00 PM"], "en")).toBe("11:00 AM and 5:00 PM");
    expect(joinTimes(["11:00 AM", "5:00 PM"], "es")).toBe("11:00 AM y 5:00 PM");

    const templates = defaultSlotFinderSettings().messageTemplates;
    const three = buildMessages({ starts: ["11:00", "15:00", "17:00"], date: FRIDAY, today: FRIDAY, templates });
    expect(three.messageEn).toContain("at 11:00 AM, 3:00 PM, and 5:00 PM.");
    expect(three.messageEs).toContain("a las 11:00 AM, 3:00 PM y 5:00 PM.");
    const two = buildMessages({ starts: ["11:00", "17:00"], date: FRIDAY, today: FRIDAY, templates });
    expect(two.messageEn).toContain("at 11:00 AM and 5:00 PM.");
    expect(two.messageEs).toContain("a las 11:00 AM y 5:00 PM.");
  });

  it("17. daylight saving: 09:00 is 14:00 UTC on 2026-03-08 and 15:00 UTC on 2026-11-01", async () => {
    expect(at("2026-03-08", "09:00").toISOString()).toBe("2026-03-08T14:00:00.000Z");
    expect(at("2026-11-01", "09:00").toISOString()).toBe("2026-11-01T15:00:00.000Z");

    const spring = await run({ date: "2026-03-08", now: at("2026-03-08", "06:00") });
    expect(spring.result.slots[0]).toMatchObject({ start: "09:00", leaveHomeBy: "8:20 AM" });
    // Round 1 prices the home leg an hour before the slot; round 2 at leave time.
    expect(spring.routeCalls[1].legs[0].departAt.toISOString()).toBe("2026-03-08T13:00:00.000Z");
    expect(spring.routeCalls[2].legs[0].departAt.toISOString()).toBe("2026-03-08T13:20:00.000Z");

    const fall = await run({ date: "2026-11-01", now: at("2026-11-01", "06:00") });
    expect(fall.result.slots[0]).toMatchObject({ start: "09:00", leaveHomeBy: "8:20 AM" });
    expect(fall.routeCalls[1].legs[0].departAt.toISOString()).toBe("2026-11-01T14:00:00.000Z");

    // The calendar window is a 23-hour and a 25-hour day, with each end's own offset.
    expect(dayWindow("2026-03-08")).toEqual({ timeMin: "2026-03-08T00:00:00-06:00", timeMax: "2026-03-09T00:00:00-05:00" });
    expect(dayWindow("2026-11-01")).toEqual({ timeMin: "2026-11-01T00:00:00-05:00", timeMax: "2026-11-02T00:00:00-06:00" });
    expect(dayWindow(FRIDAY)).toEqual({ timeMin: "2026-11-06T00:00:00-06:00", timeMax: "2026-11-07T00:00:00-06:00" });
  });
});

describe("neighbors and decision rules", () => {
  it("equality passes on both the drive in and the drive out", async () => {
    // 12:00 + 50 + 10 = 13:00, and 13:00 + 60 + 50 + 10 = 15:00.
    const { starts } = await run({
      items: [timed("11:00", "12:00", { location: KATY }), timed("15:00", "16:00", { location: KATY })],
      drives: { "katy>pasadena": 50, "pasadena>katy": 50 }
    });
    expect(starts).toContain("13:00");
  });

  it("an event before 09:00 is still PREV", async () => {
    // 08:20 + 30 + 10 = 09:00 exactly.
    const { result } = await run({ items: [timed("07:00", "08:20", { location: KATY })] });
    expect(result.slots[0]).toMatchObject({ start: "09:00", driveInMin: 30, driveOutMin: null, leaveHomeBy: null });
  });

  it("an event after 21:00 is still NEXT", async () => {
    // 21:00 + 60 + 30 + 10 = 22:40 > 22:30, so the 21:00 slot is out.
    const { starts, result } = await run({ items: [timed("22:30", "23:30", { location: KATY })] });
    expect(starts).not.toContain("21:00");
    expect(result.slots.find((s) => s.start === "19:00").driveOutMin).toBe(30);
  });

  it("on equal end times the later-starting event is PREV", async () => {
    const { routeCalls } = await run({
      items: [timed("08:00", "10:00", { location: SPRING }), timed("09:00", "10:00", { location: KATY })]
    });
    expect(routeCalls[1].legs).toContainEqual({ from: KATY, to: PASADENA, departAt: at(FRIDAY, "10:00") });
    expect(routeCalls[1].legs).not.toContainEqual({ from: SPRING, to: PASADENA, departAt: at(FRIDAY, "10:00") });
  });

  it("two NEXT events at the same start must both fit; the larger drive is reported", async () => {
    const katy2 = address("katy2");
    const fits = await run({
      items: [timed("11:00", "12:00", { location: KATY }), timed("11:00", "12:00", { location: katy2 })],
      drives: { "pasadena>katy": 20, "pasadena>katy2": 40 }
    });
    // 09:00 + 60 + 40 + 10 = 10:50 <= 11:00.
    expect(fits.result.slots[0]).toMatchObject({ start: "09:00", driveOutMin: 40 });

    const tooFar = await run({
      items: [timed("11:00", "12:00", { location: KATY }), timed("11:00", "12:00", { location: katy2 })],
      drives: { "pasadena>katy": 20, "pasadena>katy2": 55 }
    });
    expect(tooFar.starts).not.toContain("09:00");
  });

  it("a drive that cannot be calculated after round 0 drops the slot with a warning", async () => {
    const { starts, result } = await run({
      items: [timed("11:00", "12:00", { location: KATY })],
      unreachable: ["katy>pasadena"]
    });
    expect(starts).not.toContain("13:00");
    expect(result.warnings).toContain("Could not calculate the drive for the 1:00 PM slot, so it was not offered.");
  });

  it("a multi-hour event and an overnight event both block what they cover", async () => {
    const { starts } = await run({
      items: [
        timed("22:00", "23:59", { date: "2026-11-05", location: KATY }),
        { ...timed("00:00", "09:30", { location: KATY }), start: { dateTime: toChicagoRfc3339(at("2026-11-05", "22:00")) } },
        timed("12:30", "16:00", { location: SPRING })
      ]
    });
    expect(starts).toEqual(["17:00", "19:00", "21:00"]);
  });

  it("a multi-day all-day event blocks every day it covers", async () => {
    const { result } = await run({ items: [allDay("2026-11-05", "2026-11-08", { summary: "Vacation" })] });
    expect(result.state).toBe("no_slots");
  });

  it("a day where every event is ignored offers every slot", async () => {
    const { starts, routeCalls } = await run({
      items: [
        timed("09:00", "10:00", { location: KATY, status: "cancelled" }),
        timed("11:00", "12:00", { location: KATY, transparency: "transparent" }),
        timed("13:00", "14:00", { location: KATY, attendees: [{ self: true, responseStatus: "declined" }] })
      ]
    });
    expect(starts).toEqual(ALL);
    // Ignored events are not even checked as routing points.
    expect(routeCalls[0].legs).toHaveLength(1);
  });

  it("a long drive is just arithmetic", async () => {
    const { starts } = await run({
      items: [timed("11:00", "12:00", { location: KATY })],
      drives: { "katy>pasadena": 200, "pasadena>katy": 200 }
    });
    // 12:00 + 200 + 10 = 15:30: 15:00 out, 17:00 in. 09:00 needs 09:00 + 60 + 200 + 10 <= 11:00: out.
    expect(starts).toEqual(["17:00", "19:00", "21:00"]);
  });

  it("round 0 asks home to the customer and to each distinct booking location, departing now", async () => {
    const { routeCalls } = await run({
      items: [
        timed("09:00", "10:00", { location: KATY }),
        timed("15:00", "16:00", { location: `  ${KATY.toUpperCase()} ` }),
        timed("11:00", "12:00", { location: SPRING })
      ]
    });
    const round0 = routeCalls[0];
    expect(round0.legs.map((leg) => leg.to)).toEqual([PASADENA, KATY, SPRING]);
    expect(round0.legs.every((leg) => leg.from === HOME && leg.departAt.getTime() === NOW.getTime())).toBe(true);
    expect(round0.options.now).toBe(NOW);
  });

  it("no slots left after past-slot exclusion: no calendar or Routes calls", async () => {
    const { result, calendarCalls, routeCalls } = await run({ now: at(FRIDAY, "21:00") });
    expect(result.state).toBe("no_slots");
    expect(calendarCalls).toHaveLength(0);
    expect(routeCalls).toHaveLength(0);
  });

  it("uses the slot grid, buffer and home base from settings", async () => {
    const settings = mergeWithDefaults({ slotStarts: ["14:00", "10:00"], bufferMinutes: 0, homeBase: SPRING });
    const { result, routeCalls } = await run({ settings });
    expect(result.slots.map((s) => s.start)).toEqual(["10:00", "14:00"]);
    expect(result.slots[0].leaveHomeBy).toBe("9:30 AM");
    expect(routeCalls[0].legs[0].from).toBe(SPRING);
  });
});

describe("helpers", () => {
  it("Chicago date and clock formatting", () => {
    expect(chicagoDateString(new Date("2026-11-07T05:59:00Z"))).toBe("2026-11-06");
    expect(chicagoDateString(new Date("2026-11-07T06:00:00Z"))).toBe("2026-11-07");
    expect(formatClock(at(FRIDAY, "00:05"))).toBe("12:05 AM");
    expect(formatClock(at(FRIDAY, "12:00"))).toBe("12:00 PM");
    expect(dayLabel("2026-11-09", FRIDAY, "es")).toBe("el lunes");
    expect(dayLabel("2026-11-11", FRIDAY, "es")).toBe("el miércoles");
    expect(dayLabel("2026-11-14", FRIDAY, "es")).toBe("el sábado");
    expect(dayLabel(FRIDAY, FRIDAY, "es")).toBe("hoy");
  });

  it("normalizeEvents keeps summary, start, end, location, status", () => {
    const [event] = normalizeEvents([timed("09:00", "10:00", { location: ` ${KATY} `, summary: "PS5" })]);
    expect(event).toEqual({
      summary: "PS5",
      start: at(FRIDAY, "09:00"),
      end: at(FRIDAY, "10:00"),
      location: KATY,
      status: "confirmed",
      allDay: false
    });
    const [day] = normalizeEvents([allDay(FRIDAY, "2026-11-07")]);
    expect(day.start).toEqual(at(FRIDAY, "00:00"));
    expect(day.end).toEqual(at("2026-11-07", "00:00"));
  });
});

describe("the day's last job, ranking and far addresses", () => {
  it("prices the drive home for a slot with nothing after it, and not for one with a job after", async () => {
    const { result } = await run({
      items: [timed("15:00", "16:00", { location: KATY })],
      drives: { "pasadena>home": 35, "pasadena>katy": 20, "katy>pasadena": 20 }
    });
    const last = result.slots.find((slot) => slot.start === "21:00");
    expect(last).toMatchObject({ driveHomeMin: 35, homeAt: "10:35 PM", driveTotalMin: 20 + 35 });
    const before = result.slots.find((slot) => slot.start === "13:00");
    expect(before).toMatchObject({ driveOutMin: 20, driveHomeMin: null, homeAt: null });
  });

  it("drops a slot that would end the day after the home-by time, and says why", async () => {
    const settings = { ...defaultSlotFinderSettings(), homeBy: "22:30" };
    const { starts, result } = await run({ settings, drives: { "pasadena>home": 35 } });
    expect(starts).toEqual(["09:00", "11:00", "13:00", "15:00", "17:00", "19:00"]);
    expect(result.warnings).toContain(
      "The 9:00 PM slot was not offered: it would get you home around 10:35 PM, after your 10:30 PM limit."
    );

    // A limit after midnight is the next morning's.
    const late = await run({ settings: { ...defaultSlotFinderSettings(), homeBy: "00:30" }, drives: { "pasadena>home": 35 } });
    expect(late.starts).toEqual(ALL);
  });

  it("recommends the slot with the least driving around it", async () => {
    // Between two Katy jobs the drives are short; every other slot has a leg to or from home.
    const { result } = await run({
      customer: address("katy2"),
      items: [timed("11:00", "12:00", { location: KATY }), timed("15:00", "16:00", { location: KATY })],
      drives: { "katy>katy2": 5, "katy2>katy": 5, "home>katy2": 40, "katy2>home": 40 }
    });
    const recommended = result.slots.filter((slot) => slot.recommended).map((slot) => slot.start);
    expect(recommended).toEqual(["13:00"]);
    expect(result.slots.find((slot) => slot.start === "13:00").driveTotalMin).toBe(10);
    expect(result.slots.find((slot) => slot.start === "09:00").driveTotalMin).toBe(45);

    // When every slot costs the same drive, none is singled out.
    const even = await run();
    expect(even.result.slots.some((slot) => slot.recommended)).toBe(false);
  });

  it("flags an address past the far-drive mark, and stays quiet inside it", async () => {
    const far = await run({ drives: { "home>pasadena": 50 } });
    expect(far.result.farAway).toEqual({ driveMinutes: 50, limitMinutes: 45 });
    expect(far.result.warnings[0]).toContain("about 50 minutes from home base");

    expect((await run()).result.farAway).toBeNull();
    const off = await run({ drives: { "home>pasadena": 50 }, settings: { ...defaultSlotFinderSettings(), farDriveMinutes: 0 } });
    expect(off.result.farAway).toBeNull();
  });
});

describe("several days", () => {
  const deps = (itemsByDay = {}) => {
    const calendar = [];
    const routes = [];
    return {
      calendar,
      routes,
      fetchCalendarItems: async (day) => {
        calendar.push(day);
        return itemsByDay[day] || [];
      },
      getDriveMatrix: async (legs) => {
        routes.push(legs);
        return legs.map(() => ({ minutes: 30 }));
      }
    };
  };
  const search = (input, d) =>
    searchDays({ date: FRIDAY, address: PASADENA, durationMinutes: 60, settings: defaultSlotFinderSettings(), now: NOW, ...input }, d);

  it("checks one day in full and only looks at the calendar for the four after it", async () => {
    const d = deps({ "2026-11-07": [timed("09:00", "12:30", { date: "2026-11-07" })] });
    const result = await search({}, d);

    expect(result.date).toBe(FRIDAY);
    expect(result.days.map((day) => day.date)).toEqual([FRIDAY]);
    expect(result.upcoming.map((day) => [day.date, day.freeSlots])).toEqual([
      ["2026-11-07", 5],
      ["2026-11-08", 7],
      ["2026-11-09", 7],
      ["2026-11-10", 7]
    ]);
    expect(result.upcoming[0]).toMatchObject({ dayLabel: "tomorrow", starts: ["13:00", "15:00", "17:00", "19:00", "21:00"] });
    // Drive times were asked for the one day only.
    expect(d.calendar).toHaveLength(5);
    const asked = d.routes.flat().map((leg) => chicagoDateString(leg.departAt));
    expect(new Set(asked)).toEqual(new Set([FRIDAY]));
  });

  it("checks up to three days in full and writes one line per day with openings", async () => {
    const d = deps({ "2026-11-07": [allDay("2026-11-07", "2026-11-08")] });
    const result = await search({ days: 3 }, d);

    expect(result.days.map((day) => [day.date, day.state])).toEqual([
      [FRIDAY, "ok"],
      ["2026-11-07", "no_slots"],
      ["2026-11-08", "ok"]
    ]);
    expect(result.summaryEn.split("\n")).toEqual([
      "Today: 9:00 AM, 11:00 AM, 1:00 PM, 3:00 PM, 5:00 PM, 7:00 PM, and 9:00 PM",
      "Sunday, Nov 8: 9:00 AM, 11:00 AM, 1:00 PM, 3:00 PM, 5:00 PM, 7:00 PM, and 9:00 PM"
    ]);
    expect(result.summaryEs.split("\n")[0]).toMatch(/^Hoy: /);
    expect(result.upcoming[0].date).toBe("2026-11-09");
    expect((await search({ days: 9 }, deps())).days).toHaveLength(3);
  });

  it("looks nothing else up for a past date", async () => {
    const d = deps();
    const result = await search({ date: "2026-11-05" }, d);
    expect(result).toMatchObject({ state: "past_date", upcoming: [], summaryEn: null });
    expect(d.calendar).toHaveLength(0);
  });
});
