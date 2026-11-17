# 内置模型目录

此目录保存打包时下载的模型规格与价格目录：

- `models-cn.json`：由 `node scripts/fetch-models-cn.mjs` 生成；
- `models-dev.json`：由 `node scripts/fetch-models-dev.mjs` 生成。

在首次构建 Electron 桌面宿主前执行 `npm run fetch:catalogs`。CI 发布与冒烟构建也执行此步骤。
这些外部生成的 JSON 和备份不纳入版本控制；本目录不作为 Flowlet 支持模型身份白名单，
白名单仍由仓库根目录 `model-catalog.json` 维护。

Electron 构建将目录复制到运行时的 `resources/catalogs/`，Node Host 读取内置目录并保留
用户数据目录中已同步目录的优先级。下载失败时脚本保留可用的现有副本；没有副本则构建失败。
