import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";

export default defineConfig({
  base: "/",
  plugins: [react()],
  resolve: {
    alias: {
      "@flowlet/product-ui": fileURLToPath(new URL("../packages/product-ui/src/index.ts", import.meta.url)),
    },
    dedupe: ["react", "react-dom", "@douyinfe/semi-ui-19", "@douyinfe/semi-icons"],
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
