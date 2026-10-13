import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler } from "../utils.js";
import { autocomplete, resolveAddress } from "../services/geoService.js";

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

// GET /api/geo/autocomplete?q= — street suggestions for what has been typed.
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
