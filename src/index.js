import "dotenv/config";
import mongoose from "mongoose";
import app from "./app.js";

const port = Number(process.env.PORT || 4000);
let server;

if (!process.env.JWT_SECRET) throw new Error("JWT_SECRET is required");
if (!process.env.MONGODB_URI) throw new Error("MONGODB_URI is required");

async function start() {
  server = app.listen(port, "0.0.0.0", () => {
    console.log(`API running on port ${port}`);
  });
  await mongoose.connect(process.env.MONGODB_URI);
}

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down API.`);
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => { if (error) reject(error); else resolve(); });
    });
  }
  await mongoose.connection.close();
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
