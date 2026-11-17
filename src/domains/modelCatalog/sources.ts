/**
 * models-cn 目录数据源（与 Node Host `packages/flowlet-core/src/catalog/sources.ts` 保持一致）。
 *
 * models-cn 同时发布两个内容完全一致的入口：
 * - 主站 `https://models.devtrends.site/api.json`：EdgeOne 全球节点（含中国大陆），国内可达性更好，优先；
 * - GitHub Pages `https://null-object-0000.github.io/models-cn/api.json`：原有地址，作为备用镜像。
 *
 * 手动同步把主站地址交给 Host，Host 失败时会自动回退到镜像（见 `syncCatalog`）。
 */

export const MODELS_CN_PRIMARY_URL = "https://models.devtrends.site/api.json";
export const MODELS_CN_MIRROR_URL = "https://null-object-0000.github.io/models-cn/api.json";
export const MODELS_CN_SOURCE_URLS = [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL] as const;
export const MODELS_DEV_CATALOG_URL = "https://models.dev/api.json";
