import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import authRouter from "./routes/auth.js";
import entriesRouter from "./routes/entries.js";
import referenceOptionsRouter from "./routes/referenceOptions.js";

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

const app = express();

app.use(morgan("combined"));
app.use(
  cors({
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }

      callback(null, allowedOrigins.has(normalizeOrigin(origin)));
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

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});

export default app;
