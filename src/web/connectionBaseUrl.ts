/** 模型入口地址选择：同一套服务可能有多个入口（内网 IP + 公网域名），
 * 管理台里展示的 `base_url` 应该跟用户当前访问的 origin 一致，否则复制出来的地址
 * 在自己这台机器上根本连不上（内网 IP 走公网、公网域名走内网都是这个毛病）。
 */

/** 只比较 origin（协议 + 主机 + 端口），忽略路径和尾斜杠。 */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/**
 * 从候选入口里挑一条：
 * 1. origin 与当前页面完全一致的（隧道把 /v1 分流到网关时就是这个）；
 * 2. 其次用服务端给的默认值；
 * 3. 都没有就用候选里的第一条。
 */
export function pickConnectionBaseUrl(
  candidates: readonly string[] | undefined,
  fallback: string | undefined,
  pageOrigin: string,
): string {
  const list = (candidates ?? []).filter((item) => item.trim() !== "");
  const sameOrigin = list.find((item) => originOf(item) === pageOrigin);
  if (sameOrigin !== undefined) return sameOrigin;
  if (fallback !== undefined && fallback.trim() !== "") return fallback;
  return list[0] ?? "";
}
