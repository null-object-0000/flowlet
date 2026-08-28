import { useEffect, useMemo, useState } from "react";
import { Button, Input, Select, Tag, TextArea, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete, IconEdit, IconPlus } from "@douyinfe/semi-icons";
import type { McpServerSpec } from "../../domains/agent/types";
import styles from "./McpServersPanel.module.css";

const { Text } = Typography;

export type McpServerPresetId =
  | "chrome"
  | "chromeExisting"
  | "github"
  | "sequential"
  | "custom";

export const MCP_SERVER_PRESETS: Record<
  McpServerPresetId,
  { label: string; description: string; spec: McpServerSpec }
> = {
  chrome: {
    label: "Chrome DevTools（隔离）",
    description: "一次性无头浏览器 + 临时 Profile，不携带登录态；适合隐私敏感场景",
    spec: {
      id: "chrome",
      serverName: "chrome",
      transport: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--headless", "--isolated", "--no-usage-statistics"],
    },
  },
  chromeExisting: {
    label: "Chrome（连接登录）",
    description:
      "连接正在运行的 Chrome 复用登录态；需先在 chrome://inspect/#remote-debugging 开启远程调试（Chrome 144+）",
    spec: {
      id: "chrome",
      serverName: "chrome",
      transport: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@latest", "--autoConnect", "--no-usage-statistics"],
    },
  },
  github: {
    label: "GitHub",
    description: "GitHub 仓库与 Issue 工具；需要 GITHUB_TOKEN 环境变量",
    spec: {
      id: "github",
      serverName: "github",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: "" },
    },
  },
  sequential: {
    label: "Sequential Thinking",
    description: "结构化分步思考工具，无需外部服务",
    spec: {
      id: "sequential",
      serverName: "sequential",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    },
  },
  custom: {
    label: "自定义",
    description: "手动填写 transport、命令或 URL",
    spec: { id: "custom", serverName: "custom", transport: "stdio", command: "npx" },
  },
};

const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

type FormState = {
  serverName: string;
  transport: "stdio" | "streamable-http";
  command: string;
  argsText: string;
  cwd: string;
  envText: string;
  url: string;
  headersText: string;
};

function specToForm(spec: McpServerSpec): FormState {
  return {
    serverName: spec.serverName,
    transport: spec.transport,
    command: spec.command ?? "",
    argsText: (spec.args ?? []).join("\n"),
    cwd: spec.cwd ?? "",
    envText: linesFromMap(spec.env),
    url: spec.url ?? "",
    headersText: linesFromMap(spec.headers),
  };
}

function linesFromMap(map?: Record<string, string>): string {
  if (!map) return "";
  return Object.entries(map)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
}

/**
 * 解析每行 KEY=VALUE 的文本。返回 null 表示存在格式非法的行；
 * 空文本返回空对象，由调用方决定是否省略该字段。
 */
function mapFromLines(text: string): Record<string, string> | null {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.some((line) => !(line.includes("=") && line.indexOf("=") > 0))) {
    return null;
  }
  const map: Record<string, string> = {};
  for (const line of lines) {
    const separator = line.indexOf("=");
    map[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return map;
}

function formToSpec(form: FormState, previous: McpServerSpec | undefined): McpServerSpec | null {
  const spec: McpServerSpec = {
    id: previous?.id ?? "",
    serverName: form.serverName.trim(),
    transport: form.transport,
  };
  if (form.transport === "stdio") {
    spec.command = form.command.trim() || undefined;
    const args = form.argsText.split("\n").map((arg) => arg.trim()).filter((arg) => arg.length > 0);
    if (args.length > 0) spec.args = args;
    const cwd = form.cwd.trim();
    if (cwd) spec.cwd = cwd;
    const env = mapFromLines(form.envText);
    if (env === null) return null; // env 行格式错误
    if (Object.keys(env).length > 0) spec.env = env;
  } else {
    spec.url = form.url.trim() || undefined;
    const headers = mapFromLines(form.headersText);
    if (headers === null) return null;
    if (Object.keys(headers).length > 0) spec.headers = headers;
  }
  return spec;
}

function uniqueId(base: string, existing: McpServerSpec[], exceptIndex: number | null): string {
  if (!SERVER_NAME_RE.test(base)) return base;
  let candidate = base;
  let suffix = 2;
  while (
    existing.some((spec, index) => index !== exceptIndex && spec.id === candidate)
  ) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

/**
 * MCP 服务器管理面板：本地维护草稿列表，点「写回 Flowlet」一次性提交。
 * 提交成功（配置回读刷新）后按新的 servers prop 重置草稿。
 */
export function McpServersPanel({
  busy,
  disabled,
  servers,
  onSave,
}: {
  busy: boolean;
  disabled: boolean;
  servers: McpServerSpec[];
  onSave: (servers: McpServerSpec[]) => void;
}) {
  const [draft, setDraft] = useState<McpServerSpec[]>(servers);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(() => specToForm(MCP_SERVER_PRESETS.custom.spec));
  const [error, setError] = useState<string | null>(null);
  const [presetHint, setPresetHint] = useState<string>(MCP_SERVER_PRESETS.custom.description);

  useEffect(() => {
    setDraft(servers);
    setEditIndex(null);
    setError(null);
    setForm(specToForm(MCP_SERVER_PRESETS.custom.spec));
    setPresetHint(MCP_SERVER_PRESETS.custom.description);
  }, [servers]);

  const resetForm = (preset: McpServerSpec, description?: string) => {
    setEditIndex(null);
    setError(null);
    setForm(specToForm(preset));
    setPresetHint(description ?? MCP_SERVER_PRESETS.custom.description);
  };

  const startEdit = (index: number) => {
    setEditIndex(index);
    setError(null);
    setForm(specToForm(draft[index]));
    setPresetHint("");
  };

  const commitForm = () => {
    if (editIndex !== null && draft[editIndex] === undefined) return;
    const previous = editIndex === null ? undefined : draft[editIndex];
    const serverName = form.serverName.trim();
    if (!SERVER_NAME_RE.test(serverName)) {
      setError("serverName 必须是 1-32 位字母、数字、下划线或连字符（决定工具名前缀 mcp__<serverName>__）。");
      return;
    }
    if (draft.some((spec, index) => index !== editIndex && spec.serverName === serverName)) {
      setError("serverName 在存活实例中必须唯一，请换一个名称。");
      return;
    }
    if (form.transport === "stdio" && form.command.trim().length === 0) {
      setError("stdio 传输必须提供 command（如 npx）。");
      return;
    }
    if (form.transport === "streamable-http" && form.url.trim().length === 0) {
      setError("streamable-http 传输必须提供 url。");
      return;
    }
    const spec = formToSpec(form, previous);
    if (spec === null) {
      setError("KEY=VALUE 行的 KEY 不能为空，且每行必须包含一个 = 号。");
      return;
    }
    if (editIndex === null) {
      const withId = { ...spec, id: uniqueId(serverName, draft, null) };
      setDraft([...draft, withId]);
    } else {
      const next = [...draft];
      next[editIndex] = { ...spec, id: draft[editIndex].id };
      setDraft(next);
    }
    resetForm(MCP_SERVER_PRESETS.custom.spec);
  };

  const removeServer = (index: number) => {
    setDraft(draft.filter((_, itemIndex) => itemIndex !== index));
    if (editIndex === index) resetForm(MCP_SERVER_PRESETS.custom.spec);
  };

  const summary = useMemo(
    () => (index: number) => {
      const spec = draft[index];
      if (spec.transport === "stdio") {
        return [spec.command, ...(spec.args ?? [])].join(" ");
      }
      return spec.url ?? "";
    },
    [draft],
  );

  return (
    <div className={styles.panel}>
      <Text type="tertiary" size="small">
        已保存的服务器会注册为原生工具（mcp__服务器名__工具名），DSH 热替换连接、无需重启。
        Chrome 预设提供「隔离无头」和「连接登录浏览器」两种方式；连接登录浏览器会复用现有登录态，请仅在可信会话中使用。
      </Text>
      {draft.length === 0 ? (
        <div className={styles.empty}>
          <Text type="tertiary">尚未添加 MCP 服务器。从下方预设开始，或填写自定义配置。</Text>
        </div>
      ) : (
        <div className={styles.list}>
          {draft.map((spec, index) => (
            <div className={styles.row} key={spec.id}>
              <div className={styles.rowContent}>
                <div className={styles.rowTitle}>
                  <strong>{spec.serverName}</strong>
                  <Tag size="small">{spec.transport === "stdio" ? "stdio" : "http"}</Tag>
                </div>
                <small>{summary(index)}</small>
              </div>
              <div className={styles.rowActions}>
                <Button
                  aria-label={`编辑 ${spec.serverName}`}
                  icon={<IconEdit />}
                  size="small"
                  theme="borderless"
                  onClick={() => startEdit(index)}
                />
                <Button
                  aria-label={`删除 ${spec.serverName}`}
                  icon={<IconDelete />}
                  size="small"
                  theme="borderless"
                  type="danger"
                  onClick={() => removeServer(index)}
                />
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={styles.formSection}>
        <div className={styles.formHeader}>
          <strong>{editIndex === null ? "添加 MCP 服务器" : "编辑 MCP 服务器"}</strong>
          <div className={styles.presetRow}>
            {(Object.keys(MCP_SERVER_PRESETS) as McpServerPresetId[]).map((id) => (
              <Button
                key={id}
                size="small"
                theme="light"
                onClick={() =>
                  resetForm(MCP_SERVER_PRESETS[id].spec, MCP_SERVER_PRESETS[id].description)
                }
              >
                {MCP_SERVER_PRESETS[id].label}
              </Button>
            ))}
          </div>
          {editIndex === null ? (
            <Text type="tertiary" size="small">
              {presetHint}
            </Text>
          ) : null}
        </div>
        <div className={styles.fields}>
          <div className={styles.fieldRow}>
            <label className={styles.fieldLabel}>
              serverName
              <Input
                value={form.serverName}
                placeholder="chrome"
                spellCheck={false}
                onChange={(value) => setForm({ ...form, serverName: value })}
              />
            </label>
            <label className={styles.fieldLabel}>
              transport
              <Select
                value={form.transport}
                onChange={(value) =>
                  setForm({ ...form, transport: value as "stdio" | "streamable-http" })
                }
                optionList={[
                  { value: "stdio", label: "stdio（本地命令）" },
                  { value: "streamable-http", label: "streamable-http（远程服务）" },
                ]}
                style={{ width: "100%" }}
              />
            </label>
          </div>
          {form.transport === "stdio" ? (
            <>
              <label className={styles.fieldLabel}>
                command
                <Input
                  value={form.command}
                  placeholder="npx"
                  spellCheck={false}
                  onChange={(value) => setForm({ ...form, command: value })}
                />
              </label>
              <label className={styles.fieldLabel}>
                args（每行一个参数）
                <TextArea
                  value={form.argsText}
                  placeholder={"-y\nchrome-devtools-mcp@latest\n--autoConnect"}
                  autosize={{ minRows: 2, maxRows: 6 }}
                  onChange={(value) => setForm({ ...form, argsText: value })}
                />
              </label>
              <label className={styles.fieldLabel}>
                cwd（可选）
                <Input
                  value={form.cwd}
                  placeholder="如 C:\work"
                  spellCheck={false}
                  onChange={(value) => setForm({ ...form, cwd: value })}
                />
              </label>
              <label className={styles.fieldLabel}>
                env（可选，每行 KEY=VALUE）
                <TextArea
                  value={form.envText}
                  placeholder="GITHUB_TOKEN=ghp_xxx"
                  autosize={{ minRows: 1, maxRows: 4 }}
                  onChange={(value) => setForm({ ...form, envText: value })}
                />
              </label>
            </>
          ) : (
            <>
              <label className={styles.fieldLabel}>
                url
                <Input
                  value={form.url}
                  placeholder="http://127.0.0.1:9222/mcp"
                  spellCheck={false}
                  onChange={(value) => setForm({ ...form, url: value })}
                />
              </label>
              <label className={styles.fieldLabel}>
                headers（可选，每行 KEY=VALUE）
                <TextArea
                  value={form.headersText}
                  placeholder="Authorization=Bearer xxx"
                  autosize={{ minRows: 1, maxRows: 4 }}
                  onChange={(value) => setForm({ ...form, headersText: value })}
                />
              </label>
            </>
          )}
        </div>
        {error ? (
          <Text className={styles.formError} type="danger" size="small">
            {error}
          </Text>
        ) : null}
        <div className={styles.formActions}>
          {editIndex !== null ? (
            <Button
              size="small"
              theme="borderless"
              onClick={() => resetForm(MCP_SERVER_PRESETS.custom.spec)}
            >
              取消编辑
            </Button>
          ) : null}
          <Button size="small" type="primary" icon={<IconPlus />} onClick={commitForm}>
            {editIndex === null ? "添加" : "更新"}
          </Button>
        </div>
      </div>

      <div className={styles.commitRow}>
        <Text type="tertiary" size="small">
          草稿仅在点击写回后应用到已初始化的 DSH Profile；关闭会移除全部受管服务器。
        </Text>
        <Button
          type="primary"
          theme="solid"
          loading={busy}
          disabled={disabled || busy}
          onClick={() => onSave(draft)}
        >
          写回 Flowlet
        </Button>
      </div>
    </div>
  );
}