/** 环境前缀（环境别名）的纯函数：与双 Host 的 `normalize_env_prefix` 保持同一套规则。
 *
 * 前端只做展示预览（placeholder / helper / 表格列），权威校验仍在 Host 保存时执行；
 * 服务端返回的冲突/非法前缀错误会原样展示在表单 Banner。
 */

/** 旧 Host / 元数据加载失败时的 provider 默认前缀兜底（与 spec §1.2 一致）。 */
const FALLBACK_DEFAULT_ENV_PREFIX: Record<string, string> = {
  gitlab: "GITLAB",
  dockhand: "DOCKHAND",
  jenkins: "JENKINS",
  "uptime-kuma": "UPTIME_KUMA",
  beszel: "BESZEL",
  registry: "REGISTRY",
  "http-bearer": "HTTP_BEARER",
};

/** 环境变量名前缀最大长度（与 Host 校验一致）。 */
export const ENV_PREFIX_MAX_LENGTH = 24;

/** `{PREFIX}_URL` / `{PREFIX}_TOKEN`。 */
export function envKeysForPrefix(prefix: string): { url: string; token: string } {
  return { url: `${prefix}_URL`, token: `${prefix}_TOKEN` };
}

/** provider 维度的环境变量名（字段语义与双 Host 的 `env_keys` 一致）。 */
export type ProviderEnvKeys = {
  /**
   * 地址类键：默认是 baseUrl 生成的 `{PREFIX}_URL`；
   * OCI 镜像仓库的 url 槽位是 **host[:port]**（无 scheme、无路径，供 `docker login` 用），
   * 键名为 `{PREFIX}_HOST`（不用 `{PREFIX}_REGISTRY`：默认前缀就是 `REGISTRY`，会得到
   * `REGISTRY_REGISTRY`；`_HOST` 保持 `{PREFIX}_<属性>` 公式，无需特判）。
   */
  url: string;
  /**
   * 用户名类键：Jenkins / OCI 镜像仓库用登录用户名生成 `{PREFIX}_USER`，
   * Beszel 用登录邮箱生成 `{PREFIX}_EMAIL`；其余 provider 为 null。
   */
  user: string | null;
  /** 密钥类键：默认 `{PREFIX}_TOKEN`；Beszel 存登录密码，因此是 `{PREFIX}_PASSWORD`。 */
  token: string;
};

/**
 * provider 维度的环境变量名：
 *
 * - gitlab / dockhand：`{PREFIX}_URL` + `{PREFIX}_TOKEN`；
 * - jenkins：Basic 认证，额外生成 `{PREFIX}_USER`；
 * - uptime-kuma：API Key 只用于 `/metrics` 鉴权，密钥键是 `{PREFIX}_API_KEY`（不是 `_TOKEN`）；
 * - beszel：没有长期 API Token，存邮箱 + 密码 → `{PREFIX}_EMAIL` + `{PREFIX}_PASSWORD`；
 * - registry（OCI 镜像仓库）：用户名 + 密码/token 做 `docker login`，地址槽位是 host[:port]，
 *   因此生成 `{PREFIX}_HOST` + `{PREFIX}_USER` + `{PREFIX}_TOKEN`。
 */
export function envKeysForProvider(prefix: string, providerId: string): ProviderEnvKeys {
  switch (providerId) {
    case "jenkins":
      return { url: `${prefix}_URL`, user: `${prefix}_USER`, token: `${prefix}_TOKEN` };
    case "uptime-kuma":
      // Key 只用于 Prometheus /metrics 鉴权，沿用公司 infra skill 的 `UPTIME_KUMA_API_KEY` 命名。
      return { url: `${prefix}_URL`, user: null, token: `${prefix}_API_KEY` };
    case "beszel":
      return { url: `${prefix}_URL`, user: `${prefix}_EMAIL`, token: `${prefix}_PASSWORD` };
    case "registry":
      // 不是 URL：只放 host[:port]，方便直接用于 `docker login <host>` / `helm registry login`。
      return { url: `${prefix}_HOST`, user: `${prefix}_USER`, token: `${prefix}_TOKEN` };
    default:
      return { url: `${prefix}_URL`, user: null, token: `${prefix}_TOKEN` };
  }
}

/** 有序的环境变量名列表（用于预览/tooltip；过滤掉该 provider 不适用的键）。 */
export function envKeyList(keys: ProviderEnvKeys): string[] {
  return [keys.url, keys.user, keys.token].filter((key): key is string => Boolean(key));
}

/** provider 的默认前缀；服务端 `defaultEnvPrefix` 缺失时按 id 兜底。 */
export function providerDefaultEnvPrefix(provider: {
  id: string;
  defaultEnvPrefix?: string | null;
}): string {
  const fromHost = provider.defaultEnvPrefix?.trim();
  if (fromHost) return fromHost.toUpperCase();
  return FALLBACK_DEFAULT_ENV_PREFIX[provider.id] ?? provider.id.toUpperCase();
}

/** 解析后的展示前缀：空值回落默认，否则去空格并转大写（Host 也会同样归一后落库）。 */
export function resolveEnvPrefix(raw: string | null | undefined, fallback: string): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return fallback;
  return trimmed.toUpperCase();
}

/** 仅用于输入提示：是否满足 `^[A-Z][A-Z0-9_]{0,23}$`。空值合法（表示使用默认前缀）。 */
export function isValidEnvPrefixInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (!trimmed) return true;
  return /^[A-Za-z][A-Za-z0-9_]{0,23}$/.test(trimmed);
}
/**
 * 从名称/备注提取可用于环境前缀的 ASCII 片段。
 *
 * 环境变量名只能是 `[A-Za-z][A-Za-z0-9_]*`，中文无法直接映射（不做拼音猜测）；
 * 因此把非 ASCII 字符当作分隔符，只保留 ASCII 字母/数字片段，丢弃与 provider 默认
 * 前缀重复的词（例如名称「公司 Dockhand」不会生成 `DOCKHAND_DOCKHAND`）。
 */
export function envPrefixSegment(text: string, providerDefault: string): string {
  return envPrefixTokens(text, providerDefault.trim().toUpperCase()).join("_");
}

/** 单个文本里的可用片段（已去掉默认前缀词与文本内重复）。 */
function envPrefixTokens(text: string, base: string): string[] {
  const tokens = (text ?? "").toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  // base 可能是多词默认前缀（`UPTIME_KUMA` / `HTTP_BEARER`）。切出来的 token 是
  // 单词（`UPTIME`、`KUMA`），只和整串比较永远不相等，会把默认前缀拼成
  // `UPTIME_KUMA_UPTIME_KUMA`。所以按词比较。
  const baseWords = new Set([base, ...base.split("_")].filter((word) => word !== ""));
  const kept: string[] = [];
  for (const token of tokens) {
    if (baseWords.has(token)) continue;
    if (kept.includes(token)) continue;
    kept.push(token);
  }
  return kept;
}

export interface EnvPrefixSuggestionInput {
  /** provider 默认前缀（`GITLAB` / `DOCKHAND` / `JENKINS` / `BESZEL` / `REGISTRY`…）。 */
  providerDefault: string;
  name?: string | null;
  note?: string | null;
  /** 其它凭据已解析的前缀（大写）；用于避开重名，调用方应排除当前编辑项。 */
  used?: readonly string[];
}

/**
 * 根据「名称 + 备注」自动生成环境前缀，并避开已有前缀。
 *
 * 规则：
 * 1. 取名称/备注里的 ASCII 片段拼成 `{默认前缀}_{片段}`（如「公司 Dockhand NA」→ `DOCKHAND_NA`）；
 * 2. 没有可用 ASCII 片段时退化为默认前缀（如中文名 → `DOCKHAND`）；
 * 3. 与其它凭据冲突时追加 `_2`、`_3`…（同一服务多实例常见）；
 * 4. 总长度不超过 24，且去掉尾部下划线，保证满足 `^[A-Z][A-Z0-9_]{0,23}$`。
 *
 * 只是输入建议：最终归一/唯一性仍由 Host 保存时校验。
 */
export function suggestEnvPrefix(input: EnvPrefixSuggestionInput): string {
  const base = (input.providerDefault.trim().toUpperCase() || "FLOWLET").slice(0, ENV_PREFIX_MAX_LENGTH);
  const used = new Set(
    (input.used ?? []).map((prefix) => (prefix ?? "").trim().toUpperCase()).filter((prefix) => prefix !== ""),
  );
  // 名称与备注的片段合并去重（如名称「公司 sz」+ 备注「sz 线上」只保留一个 SZ）。
  const tokens: string[] = [];
  for (const text of [input.name ?? "", input.note ?? ""]) {
    for (const token of envPrefixTokens(text, base)) {
      if (!tokens.includes(token)) tokens.push(token);
    }
  }
  const segment = tokens.join("_");

  const withSegment = (value: string): string => {
    const joined = value === "" ? base : `${base}_${value}`;
    if (joined.length <= ENV_PREFIX_MAX_LENGTH) return joined;
    return joined.slice(0, ENV_PREFIX_MAX_LENGTH).replace(/_+$/, "");
  };

  const first = withSegment(segment);
  if (!used.has(first)) return first;

  for (let index = 2; index <= 99; index += 1) {
    const suffix = `_${index}`;
    const head =
      first.length + suffix.length <= ENV_PREFIX_MAX_LENGTH
        ? first
        : first.slice(0, ENV_PREFIX_MAX_LENGTH - suffix.length).replace(/_+$/, "");
    const candidate = `${head}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  // 理论上不可达（需要 99 个同前缀凭据）；兜底保持合法格式。
  return `${base.slice(0, ENV_PREFIX_MAX_LENGTH - 5)}_AUTO`;
}
