import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils.js";
import { autocomplete, geoConfig, resolveAddress } from "../services/geoService.js";

const router = Router();

router.use(requireAuth);
// The lookups go to free public services; this keeps one account from leaning
// on them harder than typing an address ever needs.
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 90,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.accountId || ipKeyGenerator(req.ip || "unknown")),
    message: { message: "Too many address lookups. Wait a moment and try again." }
  })
);

// GET /api/geo/config — the point the business works around, so the dashboard
// can describe an area by its direction and distance from it.
router.get("/config", (_req, res) => {
  const { lat, lon, defaultCity } = geoConfig();
  res.json({ center: { lat, lng: lon }, defaultCity });
});

// GET /api/geo/autocomplete?q= — streets that what has been typed could be. Slow
// and best-effort; the form asks /resolve alongside and shows that first.
router.get(
  "/autocomplete",
  asyncHandler(async (req, res) => {
    res.json({ suggestions: await autocomplete(req.query.q) });
  })
);

// GET /api/geo/resolve?address= — the exact ZIP code and coordinates of a full
// address. `match` is null when it cannot be placed.
router.get(
  "/resolve",
  asyncHandler(async (req, res) => {
    res.json({ match: await resolveAddress(req.query.address) });
  })
);

export default router;
