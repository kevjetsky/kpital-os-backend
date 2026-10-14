import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { asyncHandler, getAccountById } from "../utils.js";
import { SALES_TAX_RATE } from "../constants.js";

const router = Router();
router.use(requireAuth);

// A logo is stored inline, so it has to stay small: a few hundred pixels across
// is plenty for the top of an invoice. The dashboard resizes before uploading.
const MAX_LOGO_LENGTH = 200_000;
const LOGO_PATTERN = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/;
const TEXT_FIELDS = { name: 120, phone: 40, email: 120, address: 240, website: 160 };

function serialize(settings) {
  const profile = settings?.businessProfile || {};
  const rate = settings?.salesTaxRate;
  return {
    name: profile.name || "",
    phone: profile.phone || "",
    email: profile.email || "",
    address: profile.address || "",
    website: profile.website || "",
    logo: profile.logo || "",
    salesTaxRate: typeof rate === "number" ? rate : SALES_TAX_RATE,
    // False until the owner has saved a rate, so a device can offer the one it
    // used to keep locally.
    salesTaxRateSet: typeof rate === "number"
  };
}

// GET /api/business-profile
router.get(
  "/",
  asyncHandler(async (req, res) => {
    res.json(serialize(await getAccountById(req.accountId)));
  })
);

// PUT /api/business-profile — partial: fields left out keep their value.
router.put(
  "/",
  asyncHandler(async (req, res) => {
    const settings = await getAccountById(req.accountId);
    if (!settings) return res.status(404).json({ message: "Account not found." });

    const body = req.body ?? {};
    const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
    settings.businessProfile = settings.businessProfile || {};

    for (const [key, limit] of Object.entries(TEXT_FIELDS)) {
      if (!has(key)) continue;
      const value = String(body[key] ?? "").trim();
      if (value.length > limit) {
        return res.status(400).json({ message: `${key} is too long (${limit} characters at most).` });
      }
      settings.businessProfile[key] = value;
    }

    if (has("logo")) {
      const logo = String(body.logo ?? "");
      if (logo && (!LOGO_PATTERN.test(logo) || logo.length > MAX_LOGO_LENGTH)) {
        return res.status(400).json({ message: "The logo must be a PNG, JPEG or WebP image under about 150 KB." });
      }
      settings.businessProfile.logo = logo;
    }

    if (has("salesTaxRate")) {
      const rate = Number(body.salesTaxRate);
      if (!Number.isFinite(rate) || rate < 0 || rate > 0.25) {
        return res.status(400).json({ message: "Sales tax rate must be between 0% and 25%." });
      }
      settings.salesTaxRate = Math.round(rate * 1e6) / 1e6;
    }

    await settings.save();
    res.json(serialize(settings));
  })
);

export default router;
