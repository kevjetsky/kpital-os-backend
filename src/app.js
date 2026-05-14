import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import authRouter from "./routes/auth.js";
import entriesRouter from "./routes/entries.js";
import referenceOptionsRouter from "./routes/referenceOptions.js";
import inventoryRouter from "./routes/inventory.js";
import appointmentsRouter from "./routes/appointments.js";

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
app.use(express.json());
app.use(cookieParser());

app.get("/api/health", (_, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api/entries", entriesRouter);
app.use("/api/reference-options", referenceOptionsRouter);
app.use("/api/inventory", inventoryRouter);
app.use("/api/appointments", appointmentsRouter);

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
