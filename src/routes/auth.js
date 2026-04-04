import { Router } from "express";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import { loginSchema, setupSchema } from "../schemas.js";
import * as auth from "../controllers/authController.js";

const router = Router();

router.get("/status", auth.status);
router.post("/setup", authRateLimiter, validate(setupSchema), auth.setup);
router.post("/login", authRateLimiter, validate(loginSchema), auth.login);
router.post("/logout", auth.logout);

export default router;
