import { asyncHandler } from "../utils.js";
import { areaPoints, businessToday, insights, related, today } from "../insights/service.js";
import { calendarStops, planDay, routePlan } from "../insights/routePlan.js";
import { getSlotFinderSettings } from "../slotFinder/settings.js";
import { resolveAddress } from "../services/geoService.js";

// GET /api/entries/insights: chart series and per-customer, per-item and
// per-business totals, without the records themselves.
export const getInsights = asyncHandler(async (req, res) => {
  res.json(await insights(req.accountId));
});

// Where the day starts and ends, placed on the map. Null when it cannot be
// looked up; the route still lists every stop.
async function homeBasePoint(accountId) {
  try {
    const { homeBase } = await getSlotFinderSettings(accountId);
    const place = await resolveAddress(homeBase);
    return { address: homeBase, lat: place?.lat ?? null, lng: place?.lng ?? null };
  } catch {
    return null;
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The date asked for, or null for today; an unreadable one is a 400.
function dayParam(req, res) {
  const raw = req.query.date;
  if (raw === undefined || raw === "") return { date: null };
  if (!DATE.test(String(raw)) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
    res.status(400).json({ message: "date must be YYYY-MM-DD." });
    return null;
  }
  return { date: String(raw) };
}

// GET /api/entries/today[?date=YYYY-MM-DD]
export const getToday = asyncHandler(async (req, res) => {
  const param = dayParam(req, res);
  if (!param) return undefined;
  const [day, homeBase] = await Promise.all([today(req.accountId, new Date(), param.date), homeBasePoint(req.accountId)]);
  return res.json({ ...day, homeBase });
});

// The calendar and the drive-time allowance belong to the business that owns
// the calendar the Slot Finder reads; other accounts get an empty route.
function isCalendarOwner(accountId) {
  const owner = String(process.env.GOOGLE_CALENDAR_ACCOUNT_ID || "").trim();
  return Boolean(owner && owner === String(accountId));
}
const hasMapsKey = () => Boolean(String(process.env.GOOGLE_MAPS_API_KEY || "").trim());

// GET /api/entries/route-plan[?date=YYYY-MM-DD][&drives=0]
// The day's visits from Google Calendar, with drive times unless drives=0 (the
// Home card, which only needs the stops and must not spend the Routes allowance).
export const getRoutePlan = asyncHandler(async (req, res) => {
  const param = dayParam(req, res);
  if (!param) return undefined;
  const date = param.date || businessToday();
  const wantDrives = req.query.drives !== "0";
  const [settings, home] = await Promise.all([getSlotFinderSettings(req.accountId), homeBasePoint(req.accountId)]);
  const bare = (stops, extra) => ({
    ...planDay({ date, stops, homeBase: settings.homeBase, drives: [] }),
    warnings: [],
    home,
    drivesAvailable: false,
    ...extra
  });

  if (!isCalendarOwner(req.accountId)) return res.json(bare([], { calendarAvailable: false, unrouted: [] }));

  let found;
  try {
    found = await calendarStops(req.accountId, date);
  } catch (error) {
    return res.json(bare([], { calendarAvailable: false, unrouted: [], warnings: [error?.message || "Google Calendar could not be read."] }));
  }
  const { stops, unrouted } = found;
  if (!wantDrives || !hasMapsKey()) return res.json(bare(stops, { calendarAvailable: true, unrouted }));

  try {
    const plan = await routePlan({ date, stops, settings });
    return res.json({ ...plan, home, drivesAvailable: true, calendarAvailable: true, unrouted });
  } catch (error) {
    // Google Routes out of reach, or today's allowance used up: the stops still come back.
    return res.json(bare(stops, { calendarAvailable: true, unrouted, warnings: [error?.message || "Drive times are unavailable right now."] }));
  }
});

// GET /api/entries/related?customerId= | productServiceId= | businessId=
export const getRelated = asyncHandler(async (req, res) => {
  const { customerId, productServiceId, businessId } = req.query;
  const result = await related(req.accountId, { customerId, productServiceId, businessId });
  if (result.error) return res.status(400).json({ message: result.error });
  if (result.notFound) return res.status(404).json({ message: "Not found." });
  return res.json(result.entries);
});

// GET /api/entries/area-points
export const getAreaPoints = asyncHandler(async (req, res) => {
  res.json(await areaPoints(req.accountId));
});
