import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: [...configDefaults.exclude, "src-tauri/target/**"],
    setupFiles: [fileURLToPath(new URL("./shared/testing/setup.ts", import.meta.url))],
    globals: true,
  },
});
