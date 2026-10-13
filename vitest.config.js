import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Records with an address must not reach the public address lookups from
    // the test suite; geo tests switch this back on against a stubbed fetch.
    env: { GEO_LOOKUP: "off" },
    globals: true,
    hookTimeout: 120000,
    testTimeout: 30000,
    fileParallelism: false
  }
});
