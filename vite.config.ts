import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const devHost = process.env.TAURI_DEV_HOST;

/** 应用版本号，单一来源 package.json；经 define 注入供 flowlet-ai SDK 组装 User-Agent。 */
const appVersion = JSON.parse(
  readFileSync(new URL("./package.json", import.meta.url), "utf8"),
).version as string;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@flowlet/product-ui": fileURLToPath(new URL("./packages/product-ui/src/index.ts", import.meta.url)),
    },
    dedupe: ["react", "react-dom", "@douyinfe/semi-ui-19", "@douyinfe/semi-icons"],
  },
  clearScreen: false,
  define: {
    __FLOWLET_APP_VERSION__: JSON.stringify(appVersion),
  },
  server: {
    port: 1420,
    strictPort: true,
    host: devHost || false,
    hmr: devHost
      ? {
          protocol: "ws",
          host: devHost,
          port: 1421,
        }
      : undefined,
    watch: {
      ignored: ["**/src-tauri/target/**"],
    },
  },
  envPrefix: ["VITE_", "TAURI_"],
});
