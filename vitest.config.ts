import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/types/**", "src/main.ts"],
    },
  },
  resolve: {
    alias: {
      obsidian: path.resolve(__dirname, "tests/mocks/obsidian.ts"),
      "@": path.resolve(__dirname, "src"),
    },
  },
});
