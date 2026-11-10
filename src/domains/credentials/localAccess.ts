/** Web Host「本机接入」下载产物：读取静态 `downloads/manifest.json` 与地址拼装。
 *
 * 这些产物由 `scripts/build-local-access.mjs` 在 `dist-web/downloads/` 生成，
 * 与页面同源；只有 Web Host（`isWebHost`）会渲染入口。
 */

export type LocalAccessArtifact = {
  /** 相对 `downloads/` 的路径，例如 `flowlet-cli.tar.gz`。 */
  path: string;
  bytes: number;
  sha256: string;
};

export type LocalAccessManifest = {
  version: string;
  generatedAt: string;
  artifacts: LocalAccessArtifact[];
};

export const localAccessManifestQueryKey = ["credentials", "local-access-manifest"] as const;

/** 下载根地址：`{origin}/downloads`。 */
export function downloadsUrl(): string {
  return `${window.location.origin}/downloads`;
}

/** 页面展示与复制的地址集合。 */
export function localAccessUrls() {
  const base = downloadsUrl();
  return {
    base,
    manifest: `${base}/manifest.json`,
    installScript: `${base}/install-flowlet.sh`,
    cli: `${base}/flowlet-cli.tar.gz`,
    skills: `${base}/flowlet-skills.tar.gz`,
  };
}

/** 一行安装命令（与 spec §3.4 一致）。 */
export function installCommand(base: string): string {
  return `curl -fsSL ${base}/install-flowlet.sh | sh -s -- --base=${base}`;
}

/** 浏览器授权登录：用管理台的登录方式（OIDC/SSO 或 token 模式）换取一把只能读服务凭据的 token（本机落 `auth.json`）。 */
export function loginCommand(origin: string): string {
  return `flowlet login --server=${origin}`;
}

/** 同步凭据命令：复用 `flowlet login` 的本机授权，不再需要任何管理凭据。 */
export function pullCommand(origin: string): string {
  return `flowlet pull --server=${origin}`;
}

/** 「复制 Agent 提示词」的模板：按当前 origin 填充安装/登录/同步/Skills 地址。 */
export function agentPrompt(origin: string): string {
  const base = `${origin.replace(/\/+$/, "")}/downloads`;
  return [
    "请把本机接入 Flowlet 凭据服务：",
    `1) 安装 CLI：${installCommand(base)}`,
    `2) 登录授权：${loginCommand(origin)}（在浏览器中登录 Flowlet 管理台并确认授权；本步骤不会索取管理凭据）`,
    `3) 同步凭据：${pullCommand(origin)}`,
    `4) 安装 Skills：下载 ${base}/flowlet-skills.tar.gz，解压到你所在 Agent 的 skills 目录并阅读 flowlet-credentials/SKILL.md。`,
    "完成后运行 `flowlet list`，把可用的环境变量名和环境前缀告诉我。",
  ].join("\n");
}

/** 读取并做最小结构校验；失败时由调用方展示兜底文案，不阻塞主表格。 */
export async function fetchLocalAccessManifest(): Promise<LocalAccessManifest> {
  const response = await fetch(`${downloadsUrl()}/manifest.json`, { cache: "no-store" });
  if (!response.ok) throw new Error(`manifest.json HTTP ${response.status}`);
  const data = (await response.json()) as Partial<LocalAccessManifest> | null;
  if (
    !data ||
    typeof data.version !== "string" ||
    !Array.isArray(data.artifacts) ||
    data.artifacts.some(
      (artifact) =>
        !artifact ||
        typeof artifact.path !== "string" ||
        typeof artifact.bytes !== "number" ||
        typeof artifact.sha256 !== "string",
    )
  ) {
    throw new Error("manifest.json 格式不正确");
  }
  return {
    version: data.version,
    generatedAt: typeof data.generatedAt === "string" ? data.generatedAt : "",
    artifacts: data.artifacts,
  };
}

/** 人类可读的产物大小；避免引入新的共享依赖。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}