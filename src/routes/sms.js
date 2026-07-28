import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireSmsWebhookSecret } from "../middleware/smsWebhook.js";
import * as sms from "../controllers/smsController.js";

const router = Router();

router.get("/settings", requireAuth, sms.getSettings);
router.put("/settings", requireAuth, sms.updateSettings);
router.post("/preview", requireAuth, sms.preview);
router.get("/opt-outs", requireAuth, sms.listOptOuts);

// Carrier webhook: authenticated by shared secret, not the owner session.
router.post("/inbound/:accountId", requireSmsWebhookSecret, sms.inbound);

export default router;
