import { Router } from "express";
import { authRateLimiter } from "../middleware/rateLimiter.js";
import { validate } from "../middleware/validate.js";
import {
  loginSchema,
  setupSchema,
  signupSchema,
  verifyEmailSchema,
  resendCodeSchema,
  forgotPasswordSchema,
  resetPasswordSchema
} from "../schemas.js";
import * as auth from "../controllers/authController.js";

const router = Router();

router.get("/status", auth.status);
router.post("/setup", authRateLimiter, validate(setupSchema), auth.setup);
router.post("/signup", authRateLimiter, validate(signupSchema), auth.signup);
router.post("/login", authRateLimiter, validate(loginSchema), auth.login);
router.post("/verify-email", authRateLimiter, validate(verifyEmailSchema), auth.verifyEmail);
router.post("/resend-code", authRateLimiter, validate(resendCodeSchema), auth.resendCode);
router.post("/forgot-password", authRateLimiter, validate(forgotPasswordSchema), auth.forgotPassword);
router.post("/reset-password", authRateLimiter, validate(resetPasswordSchema), auth.resetPassword);
router.post("/logout", auth.logout);

export default router;
