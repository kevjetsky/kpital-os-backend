import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireCronSecret } from "../middleware/cron.js";
import * as notifications from "../controllers/notificationsController.js";

const router = Router();

// Cron-triggered evaluation of notification triggers. Declared first and guarded
// by the shared secret, mirroring the recurring cron route.
router.post("/cron/run", requireCronSecret, notifications.runDue);

router.get("/prefs", requireAuth, notifications.getPrefs);
router.put("/prefs", requireAuth, notifications.updatePrefs);

export default router;
