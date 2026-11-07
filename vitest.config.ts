import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // server/config demands these at import; tests never log in with them.
    env: { SESSION_SECRET: "test-secret", APP_USERNAME: "test", APP_PASSWORD: "test" },
  },
});
