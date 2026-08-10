import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 与 vite.config.ts 相同的注入：flowlet-ai SDK 的 User-Agent 版本号来源 package.json。 */
const appVersion = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
).version as string;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@flowlet/product-ui": fileURLToPath(new URL("../packages/product-ui/src/index.ts", import.meta.url)),
    },
    dedupe: ["react", "react-dom", "@douyinfe/semi-ui-19", "@douyinfe/semi-icons"],
  },
  define: {
    __FLOWLET_APP_VERSION__: JSON.stringify(appVersion),
  },
  test: {
    environment: "jsdom",
    include: ["**/*.test.ts", "**/*.test.tsx"],
    exclude: [...configDefaults.exclude, "src-tauri/target/**"],
    setupFiles: [fileURLToPath(new URL("./shared/testing/setup.ts", import.meta.url))],
    globals: true,
  },
});
