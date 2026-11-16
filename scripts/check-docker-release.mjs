// T3 runOnSettle guard. Read-only: deployment belongs to the validated task workflow.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
const runtimePaths = ["src", "public", "packages/flowlet-core", "packages/flowlet-cred", "packages/flowlet-agent-bridge", "config.json", "model-catalog.json", "plugin-registry.json", "package.json", "package-lock.json", "vite.config.ts", "tsconfig.json", "Dockerfile", "scripts/build-local-access.mjs", "scripts/install-flowlet.sh"];
async function get(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), redirect: "error" });
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return response;
}
try {
  const health = await (await get("http://10.100.217.60:20134/health")).json();
  if (health.status !== "ok") throw new Error("生产健康检查未通过");
  const container = await (await get("http://10.100.217.60:2375/containers/flowlet/json")).json();
  if (!container.State?.Running || container.State.Health?.Status === "unhealthy") throw new Error("生产容器未正常运行");
  const image = container.Config?.Image ?? "";
  const revision = /-([a-f0-9]{7,40})$/.exec(image)?.[1];
  if (!revision) throw new Error("生产镜像 tag 未标注源码 SHA，请确认发布记录并采用带 SHA 的 tag");
  git("rev-parse", "--verify", `${revision}^{commit}`);
  const files = git("diff", "--name-only", revision, "HEAD", "--", ...runtimePaths);
  if (files) throw new Error(`以下已提交改动尚未发布，请完成 Docker 发布后重新检查：\n${files}`);
  console.log(`Docker 收尾检查通过：${image}；生产健康，已提交的 Docker 相关代码已发布。`);
  console.log("工作区未提交改动不由本脚本判断归属；请按 AGENTS.md 隔离并发布本任务改动。");
} catch (error) {
  console.error(`Docker 收尾检查失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
