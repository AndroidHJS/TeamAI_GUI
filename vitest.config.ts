import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    setupFiles: "./src/setupTests.ts",
    clearMocks: true,
    exclude: ["e2e/**", "node_modules/**", "release/**"],
  },
});
