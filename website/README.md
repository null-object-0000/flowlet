# Flowlet Website

Flowlet 官网使用 EdgeOne 全球可用区（含中国大陆），生产域名保持 `https://flowlet.snewbie.site/`。Cloudflare Pages 的 Git 集成保留为备用入口。

## EdgeOne 自动部署

- 项目：`flowlet-global`（`makers-0nj1yhtkdumv`）
- GitHub Actions：`.github/workflows/deploy-website-edgeone.yml`
- 合并或提交到 `main` 后，官网、共享产品 UI、根依赖或部署配置的变更会自动触发；PR 只做官网类型检查和构建。
- 工作流也支持在 `main` 上手动运行；只发布 Tag 或 Release 不会单独触发官网部署。
- 从仓库根目录运行 `npm ci`、`npm run website:check`、`npm run website:build`，发布目录为 `website/dist`。
- 部署工具单独安装在 `scripts/edgeone`，不改变桌面端依赖；凭据来自仓库 Secrets `TENCENT_CLOUD_SECRET_ID` 和 `TENCENT_CLOUD_SECRET_KEY`。
- `website/public/edgeone.json` 随构建复制到发布目录，为 `/zh`、`/en` 等客户端路由提供 HTML 回退，并缓存带 hash 的静态资源。

网站接入仅调整 `flowlet.snewbie.site` 的 CNAME 和必要的 EdgeOne 验证记录。邮件 DNS、Flowlet 运行服务、Tunnel 及其他域名记录不参与此部署。

## Cloudflare Pages 配置

- Git repository：当前 Flowlet 仓库
- Project name：`flowlet`（默认域名 `flowlet.pages.dev`）
- Production branch：`main`
- Framework preset：`Vite`
- Root directory：留空（仓库根目录）
- Build command：`npm run website:build`
- Build output directory：`website/dist`
- Build system：V3（Node.js 22）

Build watch paths 应包含：

```text
website/*
packages/product-ui/*
```

`website` 会直接引用 `packages/product-ui` 的源码；两者已登记为根目录 npm workspace，统一使用根目录的 `package-lock.json` 和同一套 React / Semi Design 依赖。因此必须从仓库根目录执行 `npm ci`，不要在 `website` 目录单独安装依赖或生成 lockfile。这两个目录中的任意变更都必须触发官网构建。Cloudflare Git 集成会负责 production 和 preview deployments；仓库无需配置 `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_ACCOUNT_ID`。

`flowlet.pages.dev` 保留备用。生产域名的 DNS 指向 EdgeOne，备用部署不修改该 DNS 记录。Electron 桌面安装包由 `.github/workflows/build-installers.yml` 负责（见 [发布构建](../docs/release-builds.md)）；Web/Docker 部署独立于官网发布，不再构建或发布 Rust/Tauri 产物。

## 本地验证

```bash
npm ci
npm run website:check
npm run website:build
```
