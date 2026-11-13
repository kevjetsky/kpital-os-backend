import { asyncHandler } from "../utils.js";
import { areaPoints, insights, related, today } from "../insights/service.js";
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

// GET /api/entries/today
export const getToday = asyncHandler(async (req, res) => {
  const [day, homeBase] = await Promise.all([today(req.accountId), homeBasePoint(req.accountId)]);
  res.json({ ...day, homeBase });
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
