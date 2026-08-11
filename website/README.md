# Flowlet Website

Flowlet 官网由 Cloudflare Pages 的 Git 集成直接构建和发布，不再通过 GitHub Actions 或 Wrangler Direct Upload 发布。

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

`website` 会直接引用 `packages/product-ui` 的源码，因此必须从仓库根目录安装依赖，并且这两个目录中的任意变更都必须触发官网构建。Cloudflare Git 集成会负责 production 和 preview deployments；仓库无需配置 `CLOUDFLARE_API_TOKEN` 或 `CLOUDFLARE_ACCOUNT_ID`。

首次部署成功后，在 Pages 项目的 Custom domains 中绑定 `flowlet.snewbie.site`。

## 本地验证

```bash
npm run website:build
```
