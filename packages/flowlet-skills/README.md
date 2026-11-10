# flowlet-skills

Flowlet 提供给 AI Agent 的通用 Skills 包。当前包含：

- `flowlet-credentials/`：通过 `flowlet` CLI 使用 Flowlet 全局凭据库（含多实例环境前缀约定与安全规则）。

## 安装

把本包内容解压到你所使用 Agent 的 skills 目录即可（不同客户端的目录不同，Flowlet 不预设路径）：

```sh
tar -xzf flowlet-skills.tar.gz -C <你的 Agent skills 目录> --strip-components=1
```

解压后应得到 `<你的 Agent skills 目录>/flowlet-credentials/SKILL.md`。

也可以直接运行安装脚本：

```sh
./install-flowlet.sh --base=<下载地址前缀> --skills-dir=<你的 Agent skills 目录>
```
