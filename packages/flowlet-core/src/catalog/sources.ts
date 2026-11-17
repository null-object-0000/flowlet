// models-cn 目录数据源。Owner: node-storage.
//
// models-cn 同时发布两个内容完全一致的入口：
// - 主站 `https://models.devtrends.site/api.json`：EdgeOne 全球节点（含中国大陆），
//   国内网络可达性更好，作为首选；
// - GitHub Pages `https://null-object-0000.github.io/models-cn/api.json`：原有地址，
//   作为备用镜像。
//
// 两个入口的 `api.json` 逐字节一致（同一构建产物），因此可以按顺序回退：只要其中一个
// 可用就能完成目录同步。回退只发生在网络错误、非 2xx 或返回内容不是合法 JSON 时；
// 成功即停止，不合并两个来源的数据。

export const MODELS_CN_PRIMARY_URL = "https://models.devtrends.site/api.json";
export const MODELS_CN_MIRROR_URL = "https://null-object-0000.github.io/models-cn/api.json";

/** 按优先级排列的 models-cn 数据源。 */
export const MODELS_CN_URLS: readonly string[] = [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL];

/** 兼容旧入口：默认同步源仍指向主站（而不是 GitHub Pages 镜像）。 */
export const MODELS_CN_URL = MODELS_CN_PRIMARY_URL;

function sameUrl(left: string, right: string): boolean {
  return left.trim().toLowerCase().replace(/\/+$/, "") === right.trim().toLowerCase().replace(/\/+$/, "");
}

/**
 * 计算某次 models-cn 同步的候选源顺序。
 *
 * - 未指定地址（或空白）→ 默认主站 → 镜像；
 * - 显式传入内置源之一 → 该源优先，其余内置源作为回退；
 * - 显式传入自定义地址 → 只请求该地址，不猜测、不回退到内置源。
 */
export function modelsCnSourceCandidates(requested?: string | null): string[] {
  const raw = (requested ?? "").trim();
  if (raw === "") return [...MODELS_CN_URLS];
  const known = MODELS_CN_URLS.filter((url) => sameUrl(url, raw));
  if (known.length === 0) return [raw];
  const first = MODELS_CN_URLS.find((url) => sameUrl(url, raw)) as string;
  return [first, ...MODELS_CN_URLS.filter((url) => !sameUrl(url, first))];
}
