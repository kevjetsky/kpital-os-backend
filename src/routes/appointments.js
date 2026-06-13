import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as appointments from "../controllers/appointmentsController.js";

const router = Router();

router.get("/public/availability", appointments.getPublicAvailability);
router.post("/public", appointments.createPublicAppointment);
router.get("/settings", requireAuth, appointments.getSettings);
router.put("/settings", requireAuth, appointments.updateSettings);
router.get("/", requireAuth, appointments.list);
router.patch("/:id", requireAuth, appointments.update);
router.post("/:id/reminder", requireAuth, appointments.sendReminder);

export default router;
