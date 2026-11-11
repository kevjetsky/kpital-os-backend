import "dotenv/config";
import express from "express";
import compression from "compression";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import helmet from "helmet";
import authRouter from "./routes/auth.js";
import entriesRouter from "./routes/entries.js";
import recurringRouter from "./routes/recurring.js";
import referenceOptionsRouter from "./routes/referenceOptions.js";
import inventoryRouter from "./routes/inventory.js";
import backupRouter from "./routes/backup.js";
import taxRouter from "./routes/tax.js";
import pushRouter from "./routes/push.js";
import notificationsRouter from "./routes/notifications.js";
import smsRouter from "./routes/sms.js";
import geoRouter from "./routes/geo.js";
import businessProfileRouter from "./routes/businessProfile.js";
import metaRouter from "./routes/meta.js";
import slotFinderRouter from "./routes/slotFinder.js";

const DEFAULT_ALLOWED_ORIGINS = ["http://localhost:3000"];

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getAllowedOrigins() {
  const configuredOrigins = String(process.env.CLIENT_ORIGIN || "")
    .split(",")
    .map(normalizeOrigin)
    .filter(Boolean);

  const origins = configuredOrigins.length > 0 ? configuredOrigins : DEFAULT_ALLOWED_ORIGINS;
  return new Set(origins);
}

const allowedOrigins = getAllowedOrigins();

function isAllowedOrigin(origin) {
  const normalized = normalizeOrigin(origin);
  if (allowedOrigins.has(normalized)) {
    return true;
  }

  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && url.hostname.endsWith(".kpital-os.pages.dev");
  } catch {
    return false;
  }
}

const app = express();

app.disable("x-powered-by");
// The dashboard pulls the full entry list on load; over cellular that response
// dominates load time, and JSON of this shape gzips to a fraction of its size.
// App Engine's Node runtime does not compress for us.
app.use(compression());
app.use(helmet());
// The Slot Finder can take a customer's address in its query string, which must
// not be written to the access log.
morgan.token("url", (req) => {
  const url = req.originalUrl || req.url || "";
  return url.startsWith("/api/slot-finder") ? url.split("?")[0] : url;
});
app.use(morgan("combined"));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, isAllowedOrigin(origin));
    },
    credentials: true
  })
);
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const unsafe = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  if (unsafe && origin && !isAllowedOrigin(origin)) {
    return res.status(403).json({ message: "Request origin is not allowed." });
  }
  return next();
});
app.use(express.json({ limit: "256kb" }));
app.use(cookieParser());

app.get("/api/health", (_, res) => res.json({ ok: true }));
app.use("/api/meta", metaRouter);
app.use("/api/auth", authRouter);
app.use("/api/entries", entriesRouter);
app.use("/api/recurring", recurringRouter);
app.use("/api/reference-options", referenceOptionsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/backup", backupRouter);
app.use("/api/tax", taxRouter);
app.use("/api/push", pushRouter);
app.use("/api/notifications", notificationsRouter);
app.use("/api/sms", smsRouter);
app.use("/api/geo", geoRouter);
app.use("/api/business-profile", businessProfileRouter);
app.use("/api/slot-finder", slotFinderRouter);

if (process.env.SENTRY_DSN) {
  const Sentry = await import("@sentry/node");
  Sentry.setupExpressErrorHandler(app);
}

app.use((_req, res) => {
  res.status(404).json({ message: "Not found." });
});

app.use((error, _req, res, next) => {
  if (res.headersSent) {
    return next(error);
  }

  console.error(error);

  if (error?.code === 11000) {
    return res.status(409).json({ message: "Duplicate value." });
  }

  if (error?.name === "CastError") {
    return res.status(400).json({ message: "Invalid id." });
  }

  const status = Number.isInteger(error?.status) ? error.status : 500;
  const message = status === 500 ? "Internal server error." : error.message;
  return res.status(status).json({ message });
});

export default app;
