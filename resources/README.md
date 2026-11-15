# 共享资源

- `icons/`：Flowlet 应用、托盘与移动端图标，原 `src-tauri/icons/` 原样迁移；
  `icon-manifest.json` 的路径相对本目录。
- `catalogs/`：`npm run fetch:catalogs` 从 models-cn / models.dev 生成的模型目录，
  不入库；Electron 与 Android 从这里打包。首次构建前必须拉取。
- `agent-plugins/`：受管 Agent 可选扩展源码，Rust 编译时引用，Node 内嵌副本由
  `modules.test.ts` 逐字校验。部署仍遵守用户显式开启的既有边界。

这些资源不依赖宿主目录。真实上游测试文件位于 `tests/fixtures/`，
退役桌面命令兼容基线位于 `tests/contracts/desktop-commands.json`。
