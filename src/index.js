import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";

const port = Number(process.env.PORT || 4000);
let server;
let memoryServer;

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

async function connectDatabase() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
  } catch (error) {
    if (process.env.NODE_ENV === "production") {
      throw error;
    }

    console.warn("Configured MongoDB connection failed. Starting an in-memory database for local development.");
    const { MongoMemoryServer } = await import("mongodb-memory-server");
    memoryServer = await MongoMemoryServer.create();
    await mongoose.connect(memoryServer.getUri());
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
  console.error("Failed to start API", error);
  process.exit(1);
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
