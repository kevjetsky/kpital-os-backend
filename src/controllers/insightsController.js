import { asyncHandler } from "../utils.js";
import { areaPoints, businessToday, insights, related, today } from "../insights/service.js";
import { dayStops, planDay, routePlan } from "../insights/routePlan.js";
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

// The drive-time allowance belongs to the business that owns the calendar the
// Slot Finder reads; other accounts on this server get the plan without drives.
function drivesAvailable(accountId) {
  const owner = String(process.env.GOOGLE_CALENDAR_ACCOUNT_ID || "").trim();
  return Boolean(String(process.env.GOOGLE_MAPS_API_KEY || "").trim() && owner && owner === String(accountId));
}

// GET /api/entries/route-plan[?date=YYYY-MM-DD]
export const getRoutePlan = asyncHandler(async (req, res) => {
  const param = dayParam(req, res);
  if (!param) return undefined;
  const date = param.date || businessToday();
  const settings = await getSlotFinderSettings(req.accountId);
  if (!drivesAvailable(req.accountId)) {
    const stops = await dayStops(req.accountId, date);
    return res.json({ ...planDay({ date, stops, homeBase: settings.homeBase, drives: [] }), drivesAvailable: false, warnings: [] });
  }
  try {
    const plan = await routePlan({ accountId: req.accountId, date, settings });
    return res.json({ ...plan, drivesAvailable: true });
  } catch (error) {
    // Google out of reach, or today's allowance used up: the stops still come back.
    const stops = await dayStops(req.accountId, date);
    return res.json({
      ...planDay({ date, stops, homeBase: settings.homeBase, drives: [] }),
      drivesAvailable: false,
      warnings: [error?.message || "Drive times are unavailable right now."]
    });
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
