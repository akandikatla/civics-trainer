import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["lib/**/*.test.ts", "eval/**/*.test.ts"],
    // Whole-bank model tests score every question; the 33M-parameter model needs more than the 5 s default.
    testTimeout: 60_000,
  },
});
