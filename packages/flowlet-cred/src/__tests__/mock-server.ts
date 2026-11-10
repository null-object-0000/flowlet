// 测试用 mock 服务器（独立子进程，避免 spawnSync 阻塞同进程 HTTP 服务）。
// 用法：node mock-server.ts '{"mode":"gitlab",...}'；启动后 stdout 打印 PORT <n>。
import { createServer } from "node:http";

interface MockOptions {
  mode: "gitlab" | "flowlet-web";
  versionStatus?: number;
  hiddenVersion?: boolean;
  projectPages?: Array<Array<Record<string, unknown>>>;
  entries?: Array<Record<string, string>>;
  gitlabToken?: string;
  adminToken?: string;
}

const options = JSON.parse(process.argv[2] ?? "{}") as MockOptions;
const GITLAB_TOKEN = options.gitlabToken ?? "glpat-test-fixture-token-1a2b";
const ADMIN_TOKEN = options.adminToken ?? "flowlet-admin-token-0123456789";

const server = createServer((request, response) => {
  if (options.mode === "flowlet-web") {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const authorized = request.headers.authorization === `Bearer ${ADMIN_TOKEN}`;
      const payload = authorized
        ? (options.entries ?? [])
        : { code: "unauthorized", message: "管理凭据无效，请重新登录" };
      const body = Buffer.from(JSON.stringify(payload), "utf8");
      response.writeHead(authorized ? 200 : 401, {
        "content-type": "application/json",
        "content-length": String(body.length),
      });
      response.end(body);
    });
    return;
  }

  const url = new URL(request.url ?? "/", "http://localhost");
  const token = request.headers["private-token"];
  const send = (status: number, value: unknown, headers: Record<string, string> = {}): void => {
    const body = Buffer.from(JSON.stringify(value), "utf8");
    response.writeHead(status, {
      "content-type": "application/json",
      "content-length": String(body.length),
      ...headers,
    });
    response.end(body);
  };
  const suffix = url.pathname.replace(/^\/gitlab/, "");
  if (suffix === "/api/v4/user") {
    if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
    return send(200, { id: 7, username: "fixture", name: "Fixture User" });
  }
  if (suffix === "/api/v4/version") {
    if (options.hiddenVersion) return send(404, { message: "404 Not Found" });
    if (options.versionStatus !== undefined && options.versionStatus !== 200) {
      return send(options.versionStatus, { message: `${options.versionStatus} Forbidden` });
    }
    if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
    return send(200, { version: "10.8.7" });
  }
  if (suffix === "/api/v4/projects") {
    if (token !== GITLAB_TOKEN) return send(401, { message: "401 Unauthorized" });
    const pages = options.projectPages ?? [];
    const page = Number(url.searchParams.get("page") ?? "1");
    const batch = pages[page - 1] ?? [];
    const headers: Record<string, string> = { "x-page": String(page) };
    if (page < pages.length) headers["x-next-page"] = String(page + 1);
    headers["x-total"] = String(pages.flat().length);
    return send(200, batch, headers);
  }
  send(404, { message: "404 Not Found" });
});

server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  process.stdout.write(`PORT ${port}\n`);
});

process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));