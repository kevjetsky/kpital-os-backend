import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { requireCronSecret } from "../middleware/cron.js";
import * as recurring from "../controllers/recurringController.js";

const router = Router();

// Cron-triggered batch run. Declared before "/:id/run" so it is not captured as
// an id. Authenticated by shared secret, not the owner JWT.
router.post("/cron/run", requireCronSecret, recurring.runDue);

router.get("/", requireAuth, recurring.list);
router.post("/", requireAuth, recurring.create);
router.put("/:id", requireAuth, recurring.update);
router.delete("/:id", requireAuth, recurring.remove);
router.post("/:id/run", requireAuth, recurring.runOne);

export default router;
