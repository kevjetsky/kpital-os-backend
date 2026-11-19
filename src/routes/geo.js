import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { accountRateLimiter } from "../middleware/rateLimiter.js";
import { queryFromBody } from "../middleware/queryFromBody.js";
import { asyncHandler } from "../utils.js";
import { autocomplete, geoConfig, resolveAddress } from "../services/geoService.js";

const router = Router();

router.use(requireAuth);
// The lookups go to free public services; this keeps one account from leaning
// on them harder than typing an address ever needs.
router.use(accountRateLimiter({ limit: 90, message: "Too many address lookups. Wait a moment and try again." }));

// GET /api/geo/config — the point the business works around, so the dashboard
// can describe an area by its direction and distance from it.
router.get("/config", (_req, res) => {
  const { lat, lon, defaultCity } = geoConfig();
  res.json({ center: { lat, lng: lon }, defaultCity });
});

// Both lookups also answer a POST with the text in the body ({ q } or
// { address }), which is what the app sends: an address in a URL ends up in
// Google's request log (see queryFromBody.js).

// GET /api/geo/autocomplete?q= — streets that what has been typed could be. Slow
// and best-effort; the form asks /resolve alongside and shows that first.
const suggest = asyncHandler(async (req, res) => {
  res.json({ suggestions: await autocomplete(req.query.q) });
});
router.get("/autocomplete", suggest);
router.post("/autocomplete", queryFromBody, suggest);

// GET /api/geo/resolve?address= — the exact ZIP code and coordinates of a full
// address. `match` is null when it cannot be placed.
const resolve = asyncHandler(async (req, res) => {
  res.json({ match: await resolveAddress(req.query.address) });
});
router.get("/resolve", resolve);
router.post("/resolve", queryFromBody, resolve);

export default router;
