// Uptime Kuma 只读客户端（Prometheus `/metrics`）。Owner: node-web.
//
// 权威实现：src-tauri/src/core/uptime_kuma.rs 逐行为等价（CLI 侧独立副本，不依赖 flowlet-core）：
// - 2.x 没有监控管理 REST API；API Key 只用于 `/metrics` 鉴权，
//   Basic 认证用户名为空、密码为 API Key（即 `Basic base64(":" + key)`）；
// - `disableAuth=true` 的实例可能匿名 200，此时无法从响应判断 Key 真伪；
// - 保留子路径部署（https://host/uptime-kuma）；丢弃前端路由 fragment；
// - 不跟随重定向，避免把 API Key 发到别处；10s 超时；insecure 时跳过 TLS 校验。
import { Agent, request } from "undici";

const DEFAULT_TIMEOUT_MS = 10_000;
const USER_AGENT = "flowlet/0.2.0";
export const METRICS_PATH = "/metrics";

export interface MonitorStatus {
  id: string;
  name: string;
  type: string;
  up: boolean;
}

export interface KumaMetrics {
  samples: number;
  monitors: MonitorStatus[];
  version: string | null;
}

/** 与 Rust `UptimeKumaError` 同形：Display = `Uptime Kuma API {status}: {message}` / `Uptime Kuma API: {message}`。 */
export class UptimeKumaError extends Error {
  status: number | null;

  constructor(status: number | null, message: string) {
    super(message);
    this.name = "UptimeKumaError";
    this.status = status;
  }

  override toString(): string {
    return this.status === null
      ? `Uptime Kuma API: ${this.message}`
      : `Uptime Kuma API ${this.status}: ${this.message}`;
  }
}

/**
 * 规范化实例地址：与 Rust `normalize_base_url` 一致。
 * - 必须 http/https；
 * - 丢弃 fragment（前端路由 `#/settings/api-keys` 不是服务端路径）；
 * - 拒绝 query 与账号密码；
 * - 去掉末尾所有 `/`，再去掉末尾 `/metrics`；
 * - 保留子路径部署（`https://host/uptime-kuma`）。
 */
export function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") throw new Error("Uptime Kuma 地址不能为空");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Uptime Kuma 地址无法解析：${urlParseErrorDetail(trimmed)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Uptime Kuma 地址必须以 http:// 或 https:// 开头");
  }
  if (parsed.search !== "" || parsed.username !== "" || parsed.password !== "") {
    throw new Error("Uptime Kuma 地址不能带查询参数或账号密码");
  }
  // 模拟 url::Url::as_str()：小写 origin + pathname（根路径归一为 ""），再 trim 末尾斜杠。
  const pathname = parsed.pathname === "/" ? "" : parsed.pathname;
  let base = `${parsed.origin}${pathname}`.replace(/\/+$/, "");
  if (base.endsWith(METRICS_PATH)) base = base.slice(0, -METRICS_PATH.length).replace(/\/+$/, "");
  if (base === "" || base === "https:" || base === "http:" || parsed.hostname === "") {
    throw new Error("Uptime Kuma 地址缺少主机名");
  }
  return base;
}

function urlParseErrorDetail(raw: string): string {
  // url crate 的常见错误文本（用于保持错误信息可读且接近 Rust）。
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return "relative URL without a base";
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/$/.test(raw)) return "empty host";
  return "invalid URL";
}

export function metricsUrl(base: string): string {
  return `${base}${METRICS_PATH}`;
}

/** `/metrics` 的 `Authorization` 头：用户名为空、密码为 API Key。 */
export function authorizationHeader(token: string): string {
  return `Basic ${Buffer.from(`:${token}`, "utf8").toString("base64")}`;
}

export interface UptimeKumaClientOptions {
  /** 内网自签证书：跳过 TLS 校验（对应 Rust `danger_accept_invalid_certs`）。 */
  insecure?: boolean;
}

export class UptimeKumaClient {
  #base: string;
  #token: string;
  #insecure: boolean;

  constructor(url: string, token: string, options: UptimeKumaClientOptions = {}) {
    if (token.trim() === "") throw new Error("Uptime Kuma API Key 不能为空");
    this.#base = normalizeBaseUrl(url);
    this.#token = token.trim();
    this.#insecure = options.insecure ?? false;
  }

  withInsecure(insecure: boolean): UptimeKumaClient {
    this.#insecure = insecure;
    return this;
  }

  base(): string {
    return this.#base;
  }

  metricsUrl(): string {
    return metricsUrl(this.#base);
  }

  async fetchMetricsText(): Promise<string> {
    const url = this.metricsUrl();
    let response;
    try {
      response = await request(url, {
        method: "GET",
        headers: {
          authorization: authorizationHeader(this.#token),
          accept: "text/plain",
          "user-agent": USER_AGENT,
        },
        dispatcher: this.#insecure ? new Agent({ connect: { rejectUnauthorized: false } }) : undefined,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
        headersTimeout: DEFAULT_TIMEOUT_MS,
        bodyTimeout: DEFAULT_TIMEOUT_MS,
      });
    } catch (error) {
      throw new UptimeKumaError(
        null,
        `请求 ${url} 失败：${requestErrorDetail(error)}（内网自签证书请配置可信 CA 或使用 --insecure）`,
      );
    }
    const status = response.statusCode;
    const contentType = String(response.headers["content-type"] ?? "");
    let text: string;
    try {
      text = await response.body.text();
    } catch (error) {
      throw new UptimeKumaError(status, `读取 ${url} 响应失败：${errorMessage(error)}`);
    }

    if (status >= 300 && status < 400) {
      throw new UptimeKumaError(
        status,
        `${url} 返回重定向（HTTP ${status}）：请直接填写最终地址；凭据不会跟随重定向`,
      );
    }
    if (status === 401 || status === 403) {
      throw new UptimeKumaError(
        status,
        "已拒绝这把 API Key（HTTP " +
          status +
          "）：请到「设置 → API 密钥」创建或启用 Key，并确认实例已开启 API Key 鉴权",
      );
    }
    if (status === 404) {
      throw new UptimeKumaError(
        status,
        `没有找到 ${url}（HTTP 404）：请检查基础地址是否正确（子路径部署需带 /uptime-kuma）`,
      );
    }
    if (status < 200 || status >= 300) {
      throw new UptimeKumaError(status, `${url} 返回 HTTP ${status}：请检查实例地址与网络连通性`);
    }
    if (!isPrometheusContentType(contentType)) {
      throw new UptimeKumaError(
        status,
        `${url} 返回的不是 Prometheus 指标（HTTP ${status}, ${contentType}）：请检查基础地址是否包含正确的子路径（如 /uptime-kuma），且实例已启用 metrics`,
      );
    }
    if (parseMetrics(text).samples === 0) {
      throw new UptimeKumaError(status, `${url} 没有返回任何指标样本：请检查实例状态与基础地址`);
    }
    return text;
  }

  async metrics(): Promise<KumaMetrics> {
    return parseMetrics(await this.fetchMetricsText());
  }
}

function isPrometheusContentType(contentType: string): boolean {
  const lowered = contentType.toLowerCase();
  return lowered.includes("text/plain") || lowered.includes("openmetrics");
}

/** 解析 Prometheus 文本：只提取 `monitor_status`、`app_version` 与样本数。 */
export function parseMetrics(text: string): KumaMetrics {
  const metrics: KumaMetrics = { samples: 0, monitors: [], version: null };
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const sample = splitSample(line);
    if (sample === null) continue;
    metrics.samples += 1;
    const family = sample.series.split("{")[0]!.trim();
    if (family === "monitor_status") {
      const labels = parseLabels(sample.series);
      const id = labels.get("monitor_id");
      if (id === undefined) continue;
      metrics.monitors.push({
        id,
        name: labels.get("monitor_name") ?? "",
        type: labels.get("monitor_type") ?? "",
        up: sample.value === "1",
      });
    } else if (family === "app_version" && metrics.version === null) {
      const version = parseLabels(sample.series).get("version");
      if (version !== undefined && version !== "") metrics.version = version;
    }
  }
  return metrics;
}

export function summarizeMetrics(metrics: KumaMetrics): string {
  const up = metrics.monitors.filter((monitor) => monitor.up).length;
  const down = metrics.monitors.length - up;
  return `${metrics.monitors.length} 个监控（${up} 正常 / ${down} 异常）`;
}

/** 从一行样本里切出 `series`（含 labels）与数值 token；label 值可能含空格。 */
function splitSample(line: string): { series: string; value: string } | null {
  const open = line.indexOf("{");
  let seriesEnd: number;
  if (open >= 0) {
    const close = line.indexOf("}", open);
    if (close < 0) return null;
    seriesEnd = close + 1;
  } else {
    const space = line.search(/\s/);
    seriesEnd = space < 0 ? line.length : space;
  }
  const series = line.slice(0, seriesEnd);
  const rest = line.slice(seriesEnd).trimStart();
  const value = rest.split(/\s+/)[0];
  if (!value) return null;
  return { series, value };
}

/** 解析 `{a="1",b="x"}`；支持 Prometheus 的 `\\`、`\"`、`\n` 转义。 */
function parseLabels(series: string): Map<string, string> {
  const labels = new Map<string, string>();
  const open = series.indexOf("{");
  const close = series.lastIndexOf("}");
  if (open < 0 || close <= open) return labels;
  const body = series.slice(open + 1, close);
  let index = 0;
  while (index < body.length) {
    while (index < body.length && (body[index] === "," || /\s/.test(body[index]!))) index += 1;
    if (index >= body.length) break;
    const equals = body.indexOf("=", index);
    if (equals < 0) break;
    const key = body.slice(index, equals).trim();
    index = equals + 1;
    while (index < body.length && /[ \t]/.test(body[index]!)) index += 1;
    if (body[index] !== '"') {
      const nextComma = body.indexOf(",", index);
      if (nextComma < 0) break;
      index = nextComma + 1;
      continue;
    }
    index += 1;
    let value = "";
    while (index < body.length) {
      const char = body[index]!;
      index += 1;
      if (char === '"') break;
      if (char === "\\") {
        const escaped = body[index];
        if (escaped === undefined) break;
        index += 1;
        if (escaped === "n") value += "\n";
        else if (escaped === "\\") value += "\\";
        else if (escaped === '"') value += '"';
        else value += `\\${escaped}`;
      } else {
        value += char;
      }
    }
    if (key !== "") labels.set(key, value);
    const nextComma = body.indexOf(",", index);
    if (nextComma < 0) break;
    index = nextComma + 1;
  }
  return labels;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestErrorDetail(error: unknown): string {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const base = errorMessage(error);
  return cause instanceof Error ? `${base}: ${cause.message}` : base;
}