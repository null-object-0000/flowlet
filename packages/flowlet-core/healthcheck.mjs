#!/usr/bin/env node
// 容器 HEALTHCHECK：不依赖 curl/apt，直接用 Node 内置 fetch 检查 /health。
const addr = process.env.FLOWLET_WEB_ADDR ?? "0.0.0.0:8080";
const port = addr.includes(":") ? addr.slice(addr.lastIndexOf(":") + 1) : "8080";
fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(4000) })
  .then((response) => process.exit(response.ok ? 0 : 1))
  .catch(() => process.exit(1));
