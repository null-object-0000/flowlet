# DSH 0.2.0-rc.2 旧版 `settings.yaml` 迁移修复

本目录诊断并修复 `@deepseek-ai/dsh-settings@0.2.0-rc.2` 的
`SettingsForms#importLegacyDocument()` 缺陷：升级后旧的 `~/.dsh/settings.yaml`
被改名，但 Profile 的 Cordis 配置没有（完整）迁移，最终出现
`no adapter registered for provider "flowlet"`。

- `lib/legacy-import-fix.js` — 事务化的迁移实现（替换件，可直接审阅）
- `apply.mjs` — 安装 / 校验 / 回滚（`--apply`、`--check`、`--revert`）
- `tests/` — 29 个回归测试（单元 + 真实 schema + 安装器 + 真实 `dsh` E2E）

---

## 1. 现象与结论

用户报告的现象全部复现，并且是**同一处代码**造成的。

已发布实现（`dsh-settings/lib/index.js`，0.2.0-rc.2，md5 `5024d014ad19237fb91fbf8bb4370903`）：

```js
async importLegacyDocument() {
  const profile = this.ownerContext.profileContext;
  const path = join(profile.home, "settings.yaml");
  if (!existsSync(path)) return;
  const imported = `${path}.imported`;
  await rename(path, imported);                    // ① 先改名
  const sections = parse(await readFile(imported, "utf8"));
  for (const [section, values] of Object.entries(sections ?? {})) {
    const ns = LEGACY_SECTION_ENTRIES[section] ?? section;
    try {
      await this.update(ns, values);               // ② 逐个 section 独立写入
    } catch (error) {
      this.ownerContext.logger.warn(...);          // ③ 失败只告警
    }
  }
  this.ownerContext.logger.info("settings: imported %s into profile %s", ...);
}
```

三个结构性缺陷：

1. **改名早于写入**（①）：`settings.yaml` 在任何一次写入之前就被消费掉，**没有回滚**。
2. **没有事务单元**（②）：`llm-pi-ai`（Provider 路由）与 `agent-default-model`
   （引用该 Provider 的默认模型）被当作两个互不相关的 section 分别提交。
3. **失败只降级为 warning**（③）：既不知道整体迁移失败，也不会清理已写入的部分。

触发条件不是配置内容本身，而是**启动生命周期与错误传播**：只要任一 section 写入失败，
就会留下“文档已被消费、配置只写了一半”的状态。

### 1.1 复现 A：启动失败时“零迁移但文档被消费”

`dsh --profile web` 遇到 `EADDRINUSE`（重复启动 Web）时，启动审计判定失败并开始拆树；
`importLegacyDocument()` 仍在 `ctx.root.loader.await()` 之后继续执行，此时 settings 服务的
上下文已被 dispose：

```
[PROBE] importLegacyDocument enter
[PROBE] renamed -> /…/.dsh/settings.yaml.imported     ← 文档已被消费
[PROBE] sections: ["llm-pi-ai","agent-default-model"]
[PROBE] update FAILED: llm-pi-ai -- cannot get required service "configEditor" in inactive context
[PROBE] update FAILED: agent-default-model -- cannot get required service "configEditor" in inactive context
```

结果：`settings.yaml` → `settings.yaml.imported`，两个 section **一个都没写入**，
进程随即退出。这正好对应报告中的现象 1、2、3：文档被改名、Provider 没进入 Profile、
默认模型仍指向 `flowlet`。用户旧 web patch 里残留的 `- id: dsh-context / disabled: true`
只是同一份 patch 里的无关残留（loader 仅记录 `patch: entry "dsh-context" not found`），
**不是**本问题的原因。

### 1.2 复现 B：半迁移 —— 默认模型指向未注册 Provider

把 Provider profile 换成 0.2 之前的形状（profile 内含 `provider:` 字段），
adapter 自己的解析器会在写入时拒绝该 section，而依赖它的 `agent-default-model` 照常提交：

```
[PROBE] sections: ["llm-pi-ai","agent-default-model"]
[PROBE] update FAILED: llm-pi-ai -- llm-pi-ai: provider "flowlet" sets "provider",
         which moved to the providers dict key
[PROBE] update ok: agent-default-model            ← 依赖方却提交成功
```

Profile patch 只剩下：

```yaml
- id: agent-default-model
  config: { provider: flowlet, model: flowlet-pro }
```

`settings.yaml` 同时被消费。此后任何 `provider=flowlet` 的请求都会命中
`dsh-llm/lib/index.js` 的
``throw new LlmError(`no adapter registered for provider "${provider}"`, "NO_ADAPTER")``，
即报告中的现象 4。

### 1.3 为什么“有效的自定义 Provider”没有被迁移

`llm-pi-ai` 的 Config schema（`providers: z.dict(profile).default({}).volatile()`）
本身完全接受报告中的 flowlet profile：`api: openai-completions`、`apiKeyEnv`、
`baseURL`、`models[].contextWindow/input` 都能解析（见 `tests/pi-ai-profile.test.mjs`）。
迁移失败与 Profile 用户 patch、配置加载顺序、volatile schema 都无关，
单纯是 **迁移代码在生命周期与原子性上的缺陷**。

## 2. 修复

`lib/legacy-import-fix.js` 以与上游同名同签名的方法替换已发布实现，保证：

| 保证 | 实现 |
| --- | --- |
| 文档只在**全部** section 成功后才改名 | `rename()` 移到所有写入与校验之后 |
| Provider section 与 `agent-default-model` 是**一个依赖单元** | 单元按 `llm-pi-ai` → `llm-deepseek` → `agent-default-model` 排序；任一失败立即中止 |
| 任一 section 失败 → 回滚已写入的 section | 每个 section 写入前记录原始 Profile 配置，失败时逆序 `configEditor.edit(entry, () => before)` |
| 默认模型绝不指向未注册 Provider | 写前预检（文档将引入的路由 ∪ adapter 已声明的路由）+ 写后实测（`llm.listProviders()`，带 5s 上限的轮询） |
| 启动已经失败时不消费文档 | 预检 `this.closed` / fiber 状态，并在每次写入前复查；上下文 inactive 时直接放弃 |
| 失败可诊断、可直接恢复 | 保留 `settings.yaml`，写 `settings.yaml.import-error.json` 账本，`logger.error` 输出可执行提示 |
| 重试幂等 | 每次 `update()` 都是合并语义；下一次成功启动继续完成迁移 |

`settings.yaml.import-error.json` 记录：Profile 名、文档与 patch 路径、
`legacyDocumentConsumed: false`、每个失败 section 的 `phase`/`entry`/`message`、
已回滚的 section 列表、回滚失败项，以及 `remedy` 处理建议。

### 2.1 对 7 个审查点的回答

1. **为什么有效 Provider 没被迁移**：见 §1.3 —— 与 Provider 内容无关，是迁移实现的生命周期/原子性缺陷。
2. **是否受 Profile 用户 patch、加载顺序或 volatile schema 影响**：不。残留 `dsh-context` 只产生一条 loader 提示；volatile schema 与顺序都不是原因。真正相关的是**启动失败的时序**和**错误的传播方式**。
3. **是否不应在确认迁移成功前改名**：是。这是最关键的修复点，已改为最后改名。
4. **`llm-pi-ai` 与 `agent-default-model` 是否应作为依赖单元迁移**：是。已实现为原子单元，并在写前/写后校验 Provider 可解析性。
5. **section 迁移失败时应回滚/恢复/生成失败文件**：三者都做了 —— 回滚已写入的 section、保留原文档、生成可恢复的失败账本与明确错误提示。
6. **禁止“默认模型引用未注册 Provider”的半迁移状态**：由 §2 的两道校验 + 单元原子性保证；E2E `headless rejects the pre-0.2 profile shape…` 直接断言该状态不再出现。
7. **回归测试**：见 §4，覆盖自定义 `openai-completions` Provider、`apiKeyEnv`、`models/contextWindow/input`、`agent-default-model` 引用、任一 section 写入失败、Web 与 Headless Profile。

### 2.2 安装 / 校验 / 回滚

```bash
cd <flowlet 仓库根目录>

node tools/dsh-settings-legacy-import/apply.mjs --check     # 只读体检（未安装时退出码 1）
node tools/dsh-settings-legacy-import/apply.mjs --apply     # 安装（自动定位全局 dsh-settings）
node tools/dsh-settings-legacy-import/apply.mjs --revert    # 还原为官方实现
```

改动只有三处，且都在 `dsh-settings` 包内：

- 新增 `lib/legacy-import-fix.js`（本目录 `lib/` 的逐字节副本）；
- 在 `lib/index.js` **末尾追加**一段 override 块，把
  `SettingsForms.prototype.importLegacyDocument` 委托给替换件；官方代码原样保留在下面；
- 首次安装时保留 `lib/index.js.dsh-legacy-import-fix.bak` 作为原始副本。

`--apply` 幂等；`--revert` 恢复的字节与官方文件完全一致（由 `tests/install.test.mjs` 断言）。
`apply.mjs` 拒绝在非 `0.2.0-rc.2` 的版本上安装。若 DSH 被重装/升级，重新执行 `--apply` 即可。

### 2.3 已经“搁浅”的 `settings.yaml.imported` 如何恢复

修复后的实现**永不**在失败时消费文档，因此恢复动作是安全且幂等的：

```bash
mv ~/.dsh/settings.yaml.imported ~/.dsh/settings.yaml
# 重启 dsh：迁移会自动重跑；成功后才改名，失败则保留并写出失败账本
```

本机两套 Profile 已经由用户手工写入了等价的 patch，因此**无需**再执行该动作。

## 3. 本机验证记录

- 已安装修复到 `~/.nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-settings`
  （`apply.mjs --check` 报告 `patched: true, replacementModuleCurrent: true, backupPresent: true`）。
- `~/.dsh` 现状：`settings.yaml` 不存在、`settings.yaml.imported` 完整保留、无残留失败账本；
  `profiles/web/cordis.patch.yml` 与 `profiles/headless/cordis.patch.yml` 均含
  `llm-pi-ai`（flowlet）+ `agent-default-model`；`dsh-context` 残留只存在于
  `profiles/web/cordis.patch.yml.pre-flowlet-fix.bak`（已不在生效 patch 中）。
- 真实 Profile 组合（`--dump-config`）中 web / headless 的 `llm-pi-ai.providers.flowlet`
  与 `agent-default-model.provider=flowlet` 都在。
- 真实 Headless 调用（真实 `DSH_HOME`，Flowlet 本地端点 `127.0.0.1:18640`）返回
  `FLOWLET_OK`，无 `NO_ADAPTER`。
- 本会话（Web Profile）本身即以 `flowlet-pro` 运行，说明 web profile 的 flowlet 路由
  已注册。

> 全程未读取、未输出、未提交 `FLOWLET_CLIENT_TOKEN` 的实际值；E2E fixture 使用
> `e2e-placeholder-token` 占位值。

## 4. 回归测试

```bash
node --test --test-concurrency=1 tools/dsh-settings-legacy-import/tests/*.test.mjs
```

29 个测试，4 组：

| 文件 | 覆盖 |
| --- | --- |
| `legacy-import.test.mjs`（15） | 自定义 `openai-completions` Provider + `apiKeyEnv` + `models/contextWindow/input` 迁移；依赖单元顺序；Provider section 失败不提交默认模型；任一 section 失败回滚全部；默认模型指向未注册路由的写前拒绝；模型名不在 profile 列表的拒绝；写后实测未注册则回滚；上下文 inactive 时不动文档；configEditor 不可用的处理；已导入文档不重复消费；YAML 解析失败；legacy section 名映射；失败后重试成功并清理账本；Web/Headless 迁移结果一致；重复执行无副作用 |
| `pi-ai-profile.test.mjs`（7） | 真实 `dsh-llm-pi-ai` / `dsh-agent-default-model` schema：迁移写出的配置可被 adapter 接受、`apiKeyEnv` 原样保留、默认模型指向同一 patch 注册的 Provider |
| `install.test.mjs`（3） | 安装器 `--apply/--check/--revert` 字节级正确、幂等、版本拒绝；安装后的包能被加载并真正驱动迁移 |
| `e2e-profiles.test.mjs`（4） | 真实 `dsh` CLI + 临时 `DSH_HOME`：Headless 迁移成功且**下一次启动真的调用到迁移后的 Provider**（内置假 OpenAI 端点返回 `PROBE_OK`）；0.2 之前形状被拒绝且不产生 dangling 默认模型；Web 迁移成功；Web 端口占用时零写入且保留文档 |

E2E 需要已安装修复；未安装时按明确原因 skip，不会让套件变红。

### 4.1 证明这些测试确实能抓住缺陷

还原官方实现后，同一套 E2E 会有 3/4 失败，失败信息就是报告中的现象：

```bash
node tools/dsh-settings-legacy-import/apply.mjs --revert
DSH_LEGACY_IMPORT_FORCE_E2E=1 node --test --test-concurrency=1 \
  tools/dsh-settings-legacy-import/tests/e2e-profiles.test.mjs
node tools/dsh-settings-legacy-import/apply.mjs --apply
```

对官方 0.2.0-rc.2 的实测结果：

```
✖ headless rejects the pre-0.2 profile shape without committing a dangling default model
    AssertionError: the document must survive a rejected section   (actual: false)
✖ web migrates the legacy document into the web profile patch
    AssertionError: llm-pi-ai must reach the web profile patch      (actual: false)
✖ a web boot that cannot bind its port imports nothing and keeps the document
    AssertionError: a doomed boot must not consume the legacy document (actual: false)
```

（第 4 个失败正说明“先改名”的窗口：文档已被消费成 `.imported`，而 section 还没写进去。）

## 5. 已知边界

- **版本绑定**：修复针对 `0.2.0-rc.2` 的 `lib/index.js`；`apply.mjs` 对其他版本直接拒绝。
  上游修复应落在 `packages/settings/settings/src/index.ts` 的 `importLegacyDocument()`。
- **多 Profile 共享一个 home**：`<DSH_HOME>/settings.yaml` 是全局的，而写入目标是**当前**
  Profile 的 `cordis.patch.yml`。因此迁移由第一个成功启动的 Profile 消费；另一个 Profile
  不会自动获得这些 section。这是上游既有设计，本次未改动（Flowlet 的一键接入会分别写入
  Web 与 Headless）。修复后它变得更安全：失败不再消费文档，其他 Profile 仍有机会完成迁移。
- **Headless 首次启动的模型归属**：迁移发生在 `loader.await()` 之后，可能晚于 headless
  driver 创建首个 Agent，因此“本次启动”的 Agent 仍可能使用 base 默认模型
  `deepseek-official/deepseek-flash`；下一次启动才会用迁移后的默认模型。
  E2E 的两次启动断言正是覆盖这一点。
- `LEGACY_SECTION_ENTRIES` 在替换件中复制了一份（`ui-developer-tools`、`ui-onboarding`、
  `shell`）。上游新增映射时需要同步；`legacy-import.test.mjs` 覆盖了当前映射。
- 残留的 `dsh-context`（已卸载插件）属于**独立**清理项：它只产生一条 loader 提示，
  不影响 Provider 注册，本次未在代码里特殊处理。

## 6. 文件清单

```
tools/dsh-settings-legacy-import/
  README.md                     本文档
  apply.mjs                     安装 / 校验 / 回滚
  lib/legacy-import-fix.js      事务化迁移实现（安装到 dsh-settings/lib/）
  lib/locate-install.mjs        定位已安装的 dsh-settings / dsh
  tests/helpers.mjs             假 SettingsForms host、临时 DSH_HOME、假 OpenAI 端点
  tests/legacy-import.test.mjs  迁移事务语义
  tests/pi-ai-profile.test.mjs  Provider / 默认模型 schema 契约
  tests/install.test.mjs        安装器
  tests/e2e-profiles.test.mjs   真实 dsh Web / Headless E2E
```
