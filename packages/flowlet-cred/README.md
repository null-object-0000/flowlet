# Flowlet Node CLI

以下 `src/`、`bin/` 路径相对本包目录；npm 命令从仓库根运行。

当前仅维护 Node/TypeScript `flowlet` CLI，入口 `bin/flowlet.mjs` / `src/cli.ts`。
不再构建旧 CLI 或运行跨语言对拍。

仓库开发使用 Node.js 26；独立 CLI 最低要求以本包 `package.json.engines` 为准（当前 >=22.6）。
旧 Node 22 的类型剥离 flag 由 bin shim 处理，推荐用受支持的新版本。

从仓库根目录运行：

```bash
npm ci
npm run flowlet -- init
npm run flowlet -- path
npm run cred:typecheck
npm run cred:test
```

本机凭据由 `src/store.ts` 保存在单个 dotenv 与元数据 sidecar 中；`get` 默认掩码，
只有显式 `--reveal` 才显示明文。优先用 `flowlet run --with=KEY -- <程序>` 注入指定变量，
不要把密钥写进日志、文档、命令参数或提交记录。

`flowlet login` 使用独立浏览器授权，`pull` 只同步允许读取的服务凭据；
不要为 CLI 开放任意管理命令或把模型 Client Token 与管理凭据混用。
`flowlet a2a` / `flowlet acp` 只适配通用协议共同能力，不加入第三方登录/业务特例。

完整命令与数据/安全契约见 [凭据 CLI](../../docs/credential-cli.md)、
[A2A CLI](../../docs/a2a-cli.md)、[ACP 桥](../../docs/acp-bridge.md)。
