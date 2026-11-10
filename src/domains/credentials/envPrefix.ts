/** 环境前缀（环境别名）的纯函数：与双 Host 的 `normalize_env_prefix` 保持同一套规则。
 *
 * 前端只做展示预览（placeholder / helper / 表格列），权威校验仍在 Host 保存时执行；
 * 服务端返回的冲突/非法前缀错误会原样展示在表单 Banner。
 */

/** 旧 Host / 元数据加载失败时的 provider 默认前缀兜底（与 spec §1.2 一致）。 */
const FALLBACK_DEFAULT_ENV_PREFIX: Record<string, string> = {
  gitlab: "GITLAB",
  dockhand: "DOCKHAND",
};

/** 环境变量名前缀最大长度（与 Host 校验一致）。 */
export const ENV_PREFIX_MAX_LENGTH = 24;

/** `{PREFIX}_URL` / `{PREFIX}_TOKEN`。 */
export function envKeysForPrefix(prefix: string): { url: string; token: string } {
  return { url: `${prefix}_URL`, token: `${prefix}_TOKEN` };
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