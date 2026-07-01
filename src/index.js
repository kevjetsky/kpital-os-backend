import "dotenv/config";

let Sentry = null;

if (process.env.SENTRY_DSN) {
  Sentry = await import("@sentry/node");
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.SENTRY_ENVIRONMENT || process.env.NODE_ENV || "development",
    release: process.env.SENTRY_RELEASE || undefined,
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
    sendDefaultPii: false,
    enableLogs: true
  });
}

console.log("Booting API...");

const [{ default: mongoose }, { default: app }] = await Promise.all([
  import("mongoose"),
  import("./app.js")
]);

const port = Number(process.env.PORT || 4000);
let server;
let memoryServer;

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

async function connectDatabase() {
  const serverSelectionTimeoutMS = Number(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || 3000);
  const connectTimeoutMS = Number(process.env.MONGODB_CONNECT_TIMEOUT_MS || 3000);
  const useMemoryDb = process.env.USE_MEMORY_DB === "true";

  if (useMemoryDb) {
    console.log("Starting in-memory MongoDB for local development.");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri(), {
      serverSelectionTimeoutMS,
      connectTimeoutMS
    });
    console.log("Connected to in-memory MongoDB.");
    return;
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS,
      connectTimeoutMS
    });
    console.log("Connected to MongoDB.");
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw error;
    }

    console.warn("Configured MongoDB connection failed. Starting an in-memory database for local development.");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri(), {
      serverSelectionTimeoutMS,
      connectTimeoutMS
    });
    console.log("Connected to in-memory MongoDB.");
  }
}

async function start() {
  await connectDatabase();
  server = app.listen(port, "0.0.0.0", () => {
    console.log(`API running on port ${port}`);
  });
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down API.`);
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
  }
  await mongoose.connection.close();
  if (memoryServer) {
    await memoryServer.stop();
  }
}

start().catch((error) => {
  Sentry?.captureException(error);
  console.error("Failed to start API", error);
  if (Sentry) {
    void Sentry.flush(2000).finally(() => process.exit(1));
  } else {
    process.exit(1);
  }
});

["SIGINT", "SIGTERM"].forEach((signal) => {
  process.on(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch((error) => {
        console.error("Failed to shut down API cleanly", error);
        process.exit(1);
      });
  });
});
