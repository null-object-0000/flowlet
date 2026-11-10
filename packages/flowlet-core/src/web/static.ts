// 静态界面服务（含 SPA fallback）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/web/mod.rs 的
// `ServeDir::new(static_dir).not_found_service(ServeFile::new(index.html))`。
// 实测 Rust 行为（headless 二进制对拍得到）：
// - 命中文件 → 200 + content-type（mime_guess，无 charset）+ accept-ranges: bytes + last-modified；
// - 未命中 → 返回 index.html 内容但状态码是 **404**（not_found_service 保留 404）；
// - 目录且带尾斜杠 → 404 fallback（目录内无 index.html）；
// - 目录不带尾斜杠 → 307 Temporary Redirect，location 为 path + "/"；
// - 非 GET/HEAD → 405，allow: GET,HEAD。
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

/** tower-http ServeDir 用 mime_guess 推断 Content-Type（不带 charset）。 */
const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".htm": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".map": "application/json",
  ".md": "text/markdown",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".txt": "text/plain",
  ".wasm": "application/wasm",
};

export interface StaticResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}

function contentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
}

async function fileResponse(file: string, range: string | undefined): Promise<StaticResponse> {
  const info = await stat(file);
  const headers: Record<string, string> = {
    "content-type": contentType(file),
    "accept-ranges": "bytes",
    "last-modified": info.mtime.toUTCString(),
    "content-length": String(info.size),
  };
  const data = await readFile(file);
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const startRaw = match[1] === "" ? null : Number(match[1]);
      const endRaw = match[2] === "" ? null : Number(match[2]);
      let start = 0;
      let end = data.length - 1;
      if (startRaw !== null) {
        start = startRaw;
        if (endRaw !== null) end = Math.min(endRaw, data.length - 1);
      } else if (endRaw !== null) {
        start = Math.max(data.length - endRaw, 0);
      }
      if (start <= end && start < data.length) {
        const chunk = data.subarray(start, end + 1);
        headers["content-length"] = String(chunk.length);
        headers["content-range"] = `bytes ${start}-${end}/${data.length}`;
        return { status: 206, headers, body: chunk };
      }
      headers["content-range"] = `bytes */${data.length}`;
      return { status: 416, headers, body: Buffer.alloc(0) };
    }
  }
  return { status: 200, headers, body: data };
}

/**
 * 解析静态资源请求。
 *
 * @param urlPath `new URL(request.url).pathname`（未解码）
 * @param range 请求的 Range 头（可选）
 */
export async function serveStatic(
  staticDir: string,
  urlPath: string,
  range?: string,
): Promise<StaticResponse> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    decoded = "/";
  }
  const root = path.resolve(staticDir);
  const relative = decoded === "/" ? "/index.html" : decoded;
  const resolved = path.resolve(root, `.${relative}`);
  const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`);
  if (inside) {
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        if (!decoded.endsWith("/")) {
          return {
            status: 307,
            headers: { location: `${decoded}/`, "content-length": "0" },
            body: Buffer.alloc(0),
          };
        }
        const index = path.join(resolved, "index.html");
        try {
          if ((await stat(index)).isFile()) return await fileResponse(index, range);
        } catch {
          /* 目录内没有 index.html → SPA fallback */
        }
      } else if (info.isFile()) {
        return await fileResponse(resolved, range);
      }
    } catch {
      /* 未命中 → SPA fallback */
    }
  }
  // SPA fallback：内容来自 index.html，但状态码保持 404（与 Rust not_found_service 一致）。
  const fallback = path.join(root, "index.html");
  const response = await fileResponse(fallback, range);
  return { status: 404, headers: response.headers, body: response.body };
}