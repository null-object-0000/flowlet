import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banner,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  Select,
  SideSheet,
  Switch,
  Table,
  Tag,
  Toast,
  Tooltip,
  Typography,
} from "@douyinfe/semi-ui-19";
import {
  IconAIWandLevel1,
  IconCopy,
  IconDelete,
  IconDownload,
  IconEdit,
  IconEyeOpened,
  IconPlus,
  IconRefresh,
} from "@douyinfe/semi-icons";
import { credentialCommands } from "../../domains/credentials/commands";
import type {
  CredentialProvider,
  CredentialProviderId,
  ServiceCredential,
} from "../../domains/credentials/types";
import {
  ENV_PREFIX_MAX_LENGTH,
  envKeyList,
  envKeysForPrefix,
  envKeysForProvider,
  isValidEnvPrefixInput,
  providerDefaultEnvPrefix,
  resolveEnvPrefix,
  suggestEnvPrefix,
} from "../../domains/credentials/envPrefix";
import { LocalAccessSideSheet } from "../../features/credentials/LocalAccessSideSheet";
import { streamEnvPrefix, type AiStreamEvent } from "../../platform/web/aiStream";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { isWebHost } from "../../platform/web/mode";
import { PageHeader } from "../../shared/ui/PageHeader";
import { queryKeys } from "../../shared/query-keys";
import { errorMessage } from "../../shared/errors/AppError";
import { copyText } from "../../shared/ui/copyText";
import { formatTimestamp } from "../../shared/formatters/datetime";
import styles from "./CredentialsPage.module.css";

type Draft = {
  id?: string;
  provider: CredentialProviderId;
  name: string;
  baseUrl: string;
  /** 身份字段：Jenkins / OCI 镜像仓库用户名、Beszel 登录邮箱（其它 provider 不用）。 */
  username: string;
  token: string;
  note: string;
  enabled: boolean;
  /** 环境别名（Env 前缀）；空字符串表示使用 provider 默认前缀。 */
  envPrefix: string;
};

const EMPTY_DRAFT: Draft = {
  provider: "gitlab",
  name: "",
  baseUrl: "",
  username: "",
  token: "",
  note: "",
  enabled: true,
  envPrefix: "",
};

const PROVIDER_LABEL: Record<string, string> = {
  gitlab: "GitLab",
  dockhand: "Dockhand",
  jenkins: "Jenkins",
  "uptime-kuma": "Uptime Kuma",
  beszel: "Beszel",
  registry: "OCI 镜像仓库",
};

/** 服务端 provider 元数据加载前/旧 Host 的兜底，保证表单文案马上可用。 */
const FALLBACK_PROVIDERS: CredentialProvider[] = [
  {
    id: "gitlab",
    label: "GitLab",
    baseUrlHint: "https://gitlab.example.com",
    tokenLabel: "Personal Access Token（需要 api scope）",
    usernameLabel: null,
    available: true,
    defaultEnvPrefix: "GITLAB",
  },
  {
    id: "dockhand",
    label: "Dockhand",
    baseUrlHint: "http://dockhand.example.com:3000",
    tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
    usernameLabel: null,
    available: true,
    defaultEnvPrefix: "DOCKHAND",
  },
  {
    id: "jenkins",
    label: "Jenkins",
    baseUrlHint: "https://jenkins.example.com",
    tokenLabel: "API Token（Jenkins 用户设置 → API Token）",
    usernameLabel: "用户名",
    available: true,
    defaultEnvPrefix: "JENKINS",
  },
  {
    id: "uptime-kuma",
    label: "Uptime Kuma",
    baseUrlHint: "https://uptime-kuma.example.com/uptime-kuma",
    tokenLabel: "API Key（设置 → API 密钥；仅用于读取 /metrics 指标）",
    usernameLabel: null,
    available: true,
    defaultEnvPrefix: "UPTIME_KUMA",
  },
  {
    id: "beszel",
    label: "Beszel",
    baseUrlHint: "http://beszel.example.com:8090",
    tokenLabel: "登录密码（Beszel 用户密码）",
    usernameLabel: "邮箱",
    available: true,
    defaultEnvPrefix: "BESZEL",
  },
  {
    id: "registry",
    label: "OCI 镜像仓库",
    baseUrlHint: "https://hub.example.com（只填仓库地址，不要带路径）",
    tokenLabel: "密码 / Token（docker login 的密码；Harbor robot account 填其 token）",
    usernameLabel: "用户名",
    available: true,
    defaultEnvPrefix: "REGISTRY",
  },
];

/** 毫秒 → 秒（保留 1 位小数），用于 AI 生成进度展示。 */
function formatSeconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** 保存时实际校验的端点（与两套 Host 的 check 实现一致）。 */
function checkEndpoint(provider: CredentialProviderId): string {
  switch (provider) {
    case "jenkins":
      return "Jenkins /me/api/json";
    case "uptime-kuma":
      // 只读：API Key 走 Basic（空用户名）+ Prometheus /metrics。
      return "Uptime Kuma /metrics";
    case "beszel":
      return "Beszel /api/collections/users/auth-with-password";
    case "dockhand":
      return "Dockhand /api/environments";
    case "registry":
      // 标准 Registry V2 认证流程（Basic → WWW-Authenticate Bearer 质询 → token → 重试）。
      return "镜像仓库 GET /v2/";
    default:
      return "GitLab /api/v4/user";
  }
}

/** 把 Host 返回的 provider 字符串收窄为下拉可选的 id（未知类型回落 gitlab，避免下拉缺项）。 */
function asCredentialProviderId(value: string): CredentialProviderId {
  switch (value) {
    case "dockhand":
    case "jenkins":
    case "uptime-kuma":
    case "beszel":
    case "registry":
      return value;
    default:
      return "gitlab";
  }
}

/** provider 需要额外身份字段（Jenkins / OCI 镜像仓库用户名、Beszel 邮箱）；旧 Host 元数据缺失时按 id 兜底。 */
function usernameLabelFor(provider: CredentialProvider): string | null {
  const label = provider.usernameLabel?.trim();
  if (label) return label;
  if (provider.id === "beszel") return "邮箱";
  return provider.id === "jenkins" || provider.id === "registry" ? "用户名" : null;
}

/** 身份字段输入框的 placeholder。 */
function usernamePlaceholderFor(providerId: string): string {
  switch (providerId) {
    case "beszel":
      return "例如：you@example.com";
    case "registry":
      // 允许 $ + _ -，便于粘贴 robot account 这类用户名。
      return "例如：robot$project+name";
    default:
      return "例如：jenkins-user";
  }
}

/** 身份字段下方的说明文案：Jenkins 是 Basic 认证，Beszel 是邮箱+密码换短期 token，registry 用 /v2/ 验证。 */
function usernameHintFor(providerId: string): string {
  switch (providerId) {
    case "beszel":
      return "Beszel 没有长期 API Token：保存时会用邮箱 + 密码换取短期 token；编辑时留空表示保持原邮箱。";
    case "registry":
      return "保存时请求镜像仓库的 /v2/ 接口验证登录（标准 Registry V2）；编辑时留空表示保持原用户名。";
    default:
      return "Jenkins API Token 必须与该用户名的 Basic 认证一起使用；留空表示编辑时保持原用户名。";
  }
}

/** 密钥输入框的 placeholder（按 provider 与新建/编辑区分）。 */
function tokenPlaceholderFor(provider: CredentialProviderId, editing: boolean): string {
  if (editing) {
    return provider === "beszel" ? "留空表示不修改现有密码" : "留空表示不修改现有 token";
  }
  switch (provider) {
    case "dockhand":
      return "粘贴 API Token";
    case "jenkins":
      return "粘贴 API Token（与用户名一起使用）";
    case "uptime-kuma":
      return "粘贴 API Key（仅用于 /metrics 只读）";
    case "beszel":
      return "粘贴 Beszel 登录密码";
    case "registry":
      return "粘贴密码或 Token（与用户名一起用于 docker login）";
    default:
      return "粘贴 Personal Access Token";
  }
}

export function CredentialsPage() {
  const { language, t } = useAppPreferences();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  /** 「本机接入」引导抽屉：仅 Web Host 可打开。 */
  const [accessOpen, setAccessOpen] = useState(false);
  /** 编辑抽屉里临时展示的原始 token（带凭据 id，避免串到别的抽屉）；关闭抽屉即丢弃。 */
  const [revealed, setRevealed] = useState<{ id: string; token: string } | null>(null);
  /** 「AI 生成」的流式进度：tokens/tok/s/用时来自 SSE 事件，用于让用户看到真实生成进度。 */
  const [aiPrefix, setAiPrefix] = useState<{
    status: "idle" | "streaming" | "done";
    model: string;
    tokens: number;
    elapsedMs: number;
    tokPerSec: number;
  }>({ status: "idle", model: "", tokens: 0, elapsedMs: 0, tokPerSec: 0 });

  const providers = useQuery({
    queryKey: queryKeys.credentials.providers(),
    queryFn: credentialCommands.listProviders,
  });
  const list = useQuery({
    queryKey: queryKeys.credentials.list(),
    queryFn: credentialCommands.list,
  });

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials.list() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.credentials.providers() }),
    ]);

  const save = useMutation({
    mutationFn: () =>
      credentialCommands.save({
        id: draft?.id,
        name: draft?.name ?? "",
        provider: draft?.provider ?? "gitlab",
        baseUrl: draft?.baseUrl ?? "",
        username: draft?.username.trim() ? draft.username.trim() : undefined,
        token: draft?.token.trim() ? draft.token.trim() : undefined,
        kind: "cli_token",
        note: draft?.note.trim() ? draft.note.trim() : undefined,
        enabled: draft?.enabled ?? true,
        // 空值表示使用 provider 默认前缀，由 Host 归一后落库。
        envPrefix: draft?.envPrefix.trim() ? draft.envPrefix.trim() : undefined,
      }),
    onSuccess: async (credential) => {
      await invalidate();
      setDraft(null);
      setRevealed(null);
      setFormError("");
      Toast.success(`${t("已保存")}：${credential.name}`);
    },
    onError: (error) => setFormError(errorMessage(error)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => credentialCommands.remove(id),
    onSuccess: async () => {
      await invalidate();
      Toast.success(t("已删除凭据"));
    },
    onError: (error) => Toast.error(errorMessage(error)),
  });

  const reveal = useMutation({
    mutationFn: (credentialId: string) => credentialCommands.reveal(credentialId),
    onSuccess: (result) => setRevealed({ id: result.id, token: result.token }),
    onError: (error) =>
      Toast.error(t("无法查看原始 token：{message}", { message: errorMessage(error) })),
  });

  /** provider 默认前缀（服务端元数据缺失时按 id 兜底）。 */
  const defaultPrefixOf = (providerId: CredentialProviderId): string => {
    const provider = providerOptions.find((option) => option.id === providerId);
    return provider ? providerDefaultEnvPrefix(provider) : providerId.toUpperCase();
  };

  /** 其它凭据已占用的前缀（排除当前编辑项），用于自动避让。 */
  const usedEnvPrefixes = (currentId?: string): string[] =>
    (list.data ?? [])
      .filter((credential) => credential.id !== currentId)
      .map((credential) =>
        resolveEnvPrefix(credential.envPrefix, defaultPrefixOf(credential.provider as CredentialProviderId)),
      );

  /**
   * 让已开放模型根据名称/备注生成前缀片段（显式点击，一次点击 = 一次模型调用）。
   * 生成过程用 SSE 上报 token 数 / tok/s / 用时；失败只提示错误，不改动输入框。
   */
  const aiSuggestEnvPrefix = async () => {
    if (!draft || aiPrefix.status === "streaming") return;
    const providerDefault = defaultPrefixOf(draft.provider);
    const used = usedEnvPrefixes(draft.id);
    setAiPrefix({ status: "streaming", model: "", tokens: 0, elapsedMs: 0, tokPerSec: 0 });

    let failed = false;
    const handle = (event: AiStreamEvent): void => {
      if (event.type === "start") {
        setAiPrefix((current) => ({ ...current, model: event.model }));
        return;
      }
      if (event.type === "progress") {
        const tokPerSec =
          event.elapsedMs > 0 ? Math.round((event.tokens / (event.elapsedMs / 1000)) * 10) / 10 : 0;
        setAiPrefix({
          status: "streaming",
          model: targetModelRef,
          tokens: event.tokens,
          elapsedMs: event.elapsedMs,
          tokPerSec,
        });
        return;
      }
      if (event.type === "done") {
        // 片段走与手写同一套拼接与冲突避让，保证格式一致。
        const prefix = suggestEnvPrefix({ providerDefault, name: event.segment, used });
        setDraft((current) => (current ? { ...current, envPrefix: prefix } : current));
        setAiPrefix({
          status: "done",
          model: event.model,
          tokens: event.completionTokens,
          elapsedMs: event.elapsedMs,
          tokPerSec: event.tokPerSec,
        });
        Toast.success(t("已生成环境前缀：{prefix}", { prefix }));
        return;
      }
      failed = true;
      setAiPrefix({ status: "idle", model: "", tokens: 0, elapsedMs: 0, tokPerSec: 0 });
      Toast.error(t("AI 生成失败：{message}", { message: event.message }));
    };

    // 闭包里跟踪当前模型名：progress 事件本身不带 model，用 start 事件记下来的值。
    let targetModelRef = "";
    const onEvent = (event: AiStreamEvent): void => {
      if (event.type === "start") targetModelRef = event.model;
      handle(event);
    };

    try {
      await streamEnvPrefix(
        {
          provider: draft.provider,
          providerDefault,
          name: draft.name,
          note: draft.note,
          used,
        },
        onEvent,
      );
      if (!failed) {
        setAiPrefix((current) =>
          current.status === "streaming" ? { ...current, status: "done" } : current,
        );
      }
    } catch (error) {
      setAiPrefix({ status: "idle", model: "", tokens: 0, elapsedMs: 0, tokPerSec: 0 });
      Toast.error(t("AI 生成失败：{message}", { message: errorMessage(error) }));
    }
  };

  /** 关闭编辑抽屉：一并丢弃临时展示的明文 token，避免残留在内存状态里。 */
  const closeDraft = () => {
    setDraft(null);
    setRevealed(null);
    setFormError("");
  };

  const openCreate = () => {
    setFormError("");
    setRevealed(null);
    setAiPrefix({ status: "idle", model: "", tokens: 0, elapsedMs: 0, tokPerSec: 0 });
    setDraft({ ...EMPTY_DRAFT });
  };

  const openEdit = (credential: ServiceCredential) => {
    setFormError("");
    setRevealed(null);
    setAiPrefix({ status: "idle", model: "", tokens: 0, elapsedMs: 0, tokPerSec: 0 });
    setDraft({
      id: credential.id,
      provider: asCredentialProviderId(credential.provider),
      name: credential.name,
      baseUrl: credential.baseUrl,
      username: credential.username ?? "",
      token: "",
      note: credential.note ?? "",
      enabled: credential.enabled,
      // Host 返回解析后的前缀；旧 Host 缺失时留空，placeholder 显示默认前缀。
      envPrefix: credential.envPrefix ?? "",
    });
  };

  const runTest = async (credential: ServiceCredential) => {
    setTestingId(credential.id);
    try {
      const check = await credentialCommands.test(credential.id);
      if (check.ok) {
        const parts = [
          check.username ? `@${check.username}` : "",
          check.version ?? "",
          check.detail ?? "",
        ].filter(Boolean);
        Toast.success(`${credential.name} ${t("校验通过")}${parts.length ? ` · ${parts.join(" · ")}` : ""}`);
      } else {
        Toast.error(`${credential.name} ${t("校验失败")}：${check.error ?? t("未知错误")}`);
      }
      await invalidate();
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setTestingId(null);
    }
  };

  const confirmRemove = (credential: ServiceCredential) => {
    Modal.confirm({
      title: `${t("删除凭据")}：${credential.name}`,
      content: t("删除后服务端会清除加密后的 token，已同步到 Agent 机器的 .env 不受影响。"),
      okText: t("删除"),
      cancelText: t("取消"),
      onOk: () => remove.mutateAsync(credential.id),
    });
  };

  /** 复制抽屉里临时展示的明文 token；只用当前状态，不写缓存/日志。 */
  const copyRevealedToken = () => {
    if (revealed === null) return;
    void copyText(revealed.token)
      .then(() => Toast.success(t("已复制原始 token")))
      .catch((error: unknown) =>
        Toast.error(t("复制失败：{message}", { message: errorMessage(error) })),
      );
  };

  /**
   * Agent 机器上用 `flowlet login` 走浏览器管理台授权，再 `flowlet pull` 同步；
   * 页面只展示命令，不收集任何管理凭据。
   */
  const syncCommand = useMemo(() => {
    if (typeof window === "undefined") return "flowlet login --server=<Flowlet 地址>";
    return `flowlet login --server=${window.location.origin}`;
  }, []);

  const credentials = list.data ?? [];
  // 服务端按 gitlab → dockhand → jenkins → uptime-kuma → beszel → registry 的顺序返回；加载失败/旧 Host 时退回本地兜底定义。
  const providerOptions = providers.data && providers.data.length > 0 ? providers.data : FALLBACK_PROVIDERS;
  const selectedProvider = providerOptions.find((option) => option.id === draft?.provider) ?? FALLBACK_PROVIDERS[0]!;
  const selectedProviderLabel = PROVIDER_LABEL[selectedProvider.id] ?? selectedProvider.label;
  const selectedProviderDefaultEnvPrefix = providerDefaultEnvPrefix(selectedProvider);
  /** 身份字段的标题；null 表示该 provider 不需要额外身份字段。 */
  const selectedUsernameLabel = usernameLabelFor(selectedProvider);
  /**
   * 身份字段缺失：provider 声明了用户名/邮箱时，新建必须填写（Jenkins / Beszel / OCI 镜像仓库均如此）。
   * 编辑时留空表示保持原值（Host 语义）：Beszel / OCI 镜像仓库允许留空保留原值；
   * Jenkins 沿用既有交互，编辑时仍要求填写用户名。
   */
  const usernameMissing =
    selectedUsernameLabel !== null &&
    !draft?.username.trim() &&
    (draft?.id === undefined ||
      (selectedProvider.id !== "beszel" && selectedProvider.id !== "registry"));
  /** 编辑器的环境前缀预览：空值 → provider 默认，非空 → 大写。 */
  const previewPrefix = resolveEnvPrefix(draft?.envPrefix, selectedProviderDefaultEnvPrefix);
  const previewEnvKeys = envKeysForProvider(previewPrefix, selectedProvider.id);
  /** 前缀示例按 provider 默认前缀展开，提醒用户填写完整前缀而不是只填别名。 */
  const envPrefixExample = `${selectedProviderDefaultEnvPrefix}_NA`;
  const envPrefixInvalid = draft !== null && !isValidEnvPrefixInput(draft.envPrefix);
  /** 生成的环境变量名文案（Jenkins / registry 多 `_USER`，registry 的地址槽位是 `_HOST`，Beszel 为 `_EMAIL` / `_PASSWORD`）。 */
  const previewEnvKeyLabels = envKeyList(previewEnvKeys).join(" / ");

  /** 编辑态才有「查看已保存 token」入口；新建时还没有已保存凭据。 */
  const editingCredentialId = draft?.id;
  /** 只在当前编辑的凭据上展示明文：异步返回的旧结果不会串到别的抽屉里。 */
  const revealedToken =
    revealed !== null && revealed.id === editingCredentialId ? revealed.token : null;

  /** 表格/预览用：旧 Host 未返回 envPrefix 时按 provider 默认前缀兜底。 */
  const defaultEnvPrefixFor = (providerId: string): string => {
    const provider = providerOptions.find((option) => option.id === providerId);
    return provider ? providerDefaultEnvPrefix(provider) : providerId.toUpperCase();
  };

  return (
    <main className={styles.page}>
      <PageHeader
        title={t("服务凭据")}
        subtitle={t("集中管理 Agent 接入所需的三方服务 token；保存前会实际校验实例与凭据")}
      >
        {isWebHost && (
          <Button icon={<IconDownload />} onClick={() => setAccessOpen(true)}>
            {t("本机接入")}
          </Button>
        )}
        <Button icon={<IconPlus />} theme="solid" onClick={openCreate}>
          {t("添加凭据")}
        </Button>
      </PageHeader>

      <Banner
        type="info"
        closeIcon={null}
        description={
          <span className={styles.syncHint}>
            {t("Agent 机器上用 CLI 登录并同步到本地 .env：")}
            <Typography.Text code copyable>
              {syncCommand}
            </Typography.Text>
          </span>
        }
      />

      {list.error && <Banner type="danger" description={errorMessage(list.error)} />}

      <Card className={styles.card} bodyStyle={{ padding: 0 }}>
        {credentials.length === 0 && !list.isLoading ? (
          <Empty
            title={t("还没有服务凭据")}
            description={t("添加一个服务凭据后，Agent 就能通过 CLI 同步并使用它。")}
          >
            <Button theme="solid" onClick={openCreate}>
              {t("添加凭据")}
            </Button>
          </Empty>
        ) : (
          <Table
            rowKey="id"
            loading={list.isLoading}
            dataSource={credentials}
            pagination={false}
            columns={[
              {
                title: t("名称"),
                dataIndex: "name",
                render: (_, row) => (
                  <div className={styles.nameCell}>
                    <Typography.Text strong>{row.name}</Typography.Text>
                    {row.note && <Typography.Text type="tertiary">{row.note}</Typography.Text>}
                  </div>
                ),
              },
              {
                title: t("服务"),
                dataIndex: "provider",
                width: 110,
                render: (value: string) => (
                  <Tag color="blue" type="light">
                    {PROVIDER_LABEL[value] ?? value}
                  </Tag>
                ),
              },
              {
                title: t("实例地址"),
                dataIndex: "baseUrl",
                render: (value: string, row) => (
                  <div className={styles.nameCell}>
                    <Typography.Text ellipsis={{ showTooltip: true }}>{value}</Typography.Text>
                    {row.username && (
                      <Typography.Text type="tertiary" size="small">
                        @{row.username}
                      </Typography.Text>
                    )}
                  </div>
                ),
              },
              {
                title: t("环境前缀"),
                dataIndex: "envPrefix",
                width: 150,
                render: (_, row) => {
                  const prefix = resolveEnvPrefix(row.envPrefix, defaultEnvPrefixFor(row.provider));
                  const keys = envKeysForProvider(prefix, row.provider);
                  return (
                    <Tooltip
                      content={
                        <div className={styles.envKeyTooltip}>
                          {envKeyList(keys).map((key) => (
                            <code key={key}>{key}</code>
                          ))}
                        </div>
                      }
                    >
                      <Typography.Text code>{prefix}_*</Typography.Text>
                    </Tooltip>
                  );
                },
              },
              {
                title: t("最近校验"),
                dataIndex: "lastVerifiedAt",
                width: 190,
                render: (value: string | null, row) => {
                  if (row.lastError) {
                    return (
                      <Typography.Text type="danger" ellipsis={{ showTooltip: true }}>
                        {row.lastError}
                      </Typography.Text>
                    );
                  }
                  return (
                    <Typography.Text type="tertiary">
                      {value ? formatTimestamp(value, language) : t("从未校验")}
                    </Typography.Text>
                  );
                },
              },
              {
                title: t("状态"),
                dataIndex: "enabled",
                width: 90,
                render: (value: boolean) => (
                  <Tag color={value ? "green" : "grey"} type="light">
                    {value ? t("启用") : t("停用")}
                  </Tag>
                ),
              },
              {
                title: t("操作"),
                width: 250,
                render: (_, row) => (
                  <div className={styles.actions}>
                    <Button
                      size="small"
                      icon={<IconRefresh />}
                      loading={testingId === row.id}
                      onClick={() => void runTest(row)}
                    >
                      {t("测试")}
                    </Button>
                    <Button size="small" icon={<IconEdit />} onClick={() => openEdit(row)}>
                      {t("编辑")}
                    </Button>
                    <Button
                      size="small"
                      type="danger"
                      icon={<IconDelete />}
                      onClick={() => confirmRemove(row)}
                    >
                      {t("删除")}
                    </Button>
                  </div>
                ),
              },
            ]}
          />
        )}
      </Card>

      <SideSheet
        title={draft?.id ? t("编辑服务凭据") : t("添加服务凭据")}
        visible={draft !== null}
        onCancel={closeDraft}
        width={480}
        footer={
          <div className={styles.sheetFooter}>
            <Button onClick={closeDraft}>{t("取消")}</Button>
            <Button
              theme="solid"
              loading={save.isPending}
              disabled={
                !draft?.name.trim() ||
                !draft?.baseUrl.trim() ||
                (!draft?.id && !draft?.token.trim()) ||
                usernameMissing ||
                envPrefixInvalid
              }
              onClick={() => {
                setFormError("");
                save.mutate();
              }}
            >
              {t("保存并校验")}
            </Button>
          </div>
        }
      >
        {draft && (
          <div className={styles.form}>
            {formError && <Banner type="danger" description={formError} />}
            <div className={styles.field}>
              <label>{t("名称")}</label>
              <Input
                value={draft.name}
                placeholder={t("例如：公司 {name}", { name: selectedProviderLabel })}
                onChange={(value) => setDraft((current) => (current ? { ...current, name: value } : current))}
              />
            </div>
            <div className={styles.field}>
              <label>{t("服务类型")}</label>
              <Select
                value={draft.provider}
                disabled={draft.id !== undefined}
                style={{ width: "100%" }}
                optionList={providerOptions.map((option) => ({
                  value: option.id,
                  label: option.label,
                  disabled: !option.available,
                }))}
                onChange={(value) =>
                  setDraft((current) =>
                    current ? { ...current, provider: value as CredentialProviderId } : current,
                  )
                }
              />
              <Typography.Text type="tertiary">{t(selectedProvider.tokenLabel)}</Typography.Text>
            </div>
            {selectedUsernameLabel !== null && (
              <div className={styles.field}>
                <label>{t(selectedUsernameLabel)}</label>
                <Input
                  value={draft.username}
                  placeholder={t(usernamePlaceholderFor(draft.provider))}
                  onChange={(value) =>
                    setDraft((current) => (current ? { ...current, username: value } : current))
                  }
                />
                <Typography.Text type="tertiary" size="small">
                  {t(usernameHintFor(draft.provider))}
                </Typography.Text>
              </div>
            )}
            <div className={styles.field}>
              <label>{t("实例地址")}</label>
              <Input
                value={draft.baseUrl}
                placeholder={selectedProvider.baseUrlHint}
                onChange={(value) => setDraft((current) => (current ? { ...current, baseUrl: value } : current))}
              />
            </div>
            <div className={styles.field}>
              <div className={styles.fieldLabelRow}>
                <label>{t("环境别名（Env 前缀）")}</label>
                {isWebHost && (
                  <Button
                    size="small"
                    theme="borderless"
                    icon={<IconAIWandLevel1 />}
                    loading={aiPrefix.status === "streaming"}
                    disabled={!draft.name.trim()}
                    onClick={() => void aiSuggestEnvPrefix()}
                  >
                    {t("AI 生成")}
                  </Button>
                )}
              </div>
              <Input
                value={draft.envPrefix}
                placeholder={t("留空使用默认 {prefix}，或点「AI 生成」按名称/备注生成", {
                  prefix: selectedProviderDefaultEnvPrefix,
                })}
                onChange={(value) =>
                  setDraft((current) => (current ? { ...current, envPrefix: value } : current))
                }
              />
              {aiPrefix.status !== "idle" ? (
                <div className={styles.aiProgress} role="status" aria-live="polite">
                  {aiPrefix.status === "streaming" ? (
                    <>
                      <span className={styles.aiProgressDot} aria-hidden="true" />
                      {t("AI 生成中")}
                      {aiPrefix.model !== "" ? ` · ${aiPrefix.model}` : ""}
                      {` · ${t("已生成 {tokens} tokens", { tokens: aiPrefix.tokens })}`}
                      {aiPrefix.tokPerSec > 0 ? ` · ${aiPrefix.tokPerSec} tok/s` : ""}
                      {` · ${formatSeconds(aiPrefix.elapsedMs)}`}
                    </>
                  ) : (
                    <>
                      {t("AI 已生成")}
                      {` · ${aiPrefix.tokens} tokens`}
                      {` · ${aiPrefix.tokPerSec} tok/s`}
                      {` · ${formatSeconds(aiPrefix.elapsedMs)}`}
                    </>
                  )}
                </div>
              ) : null}
              {envPrefixInvalid ? (
                <Typography.Text type="danger" size="small">
                  {t("环境前缀只能包含字母、数字和下划线，且以字母开头（最长 {max} 个字符）", {
                    max: ENV_PREFIX_MAX_LENGTH,
                  })}
                </Typography.Text>
              ) : (
                <Typography.Text type="tertiary" size="small">
                  {t("生成的环境变量：{keys}；同一服务的多实例需使用不同前缀（如 {example}）。", {
                    keys: previewEnvKeyLabels,
                    example: envPrefixExample,
                  })}
                </Typography.Text>
              )}
            </div>
            <div className={styles.field}>
              <div className={styles.fieldLabelRow}>
                <label>{t("Token")}</label>
                {editingCredentialId !== undefined &&
                  (revealedToken === null ? (
                    <Button
                      size="small"
                      theme="borderless"
                      icon={<IconEyeOpened />}
                      loading={reveal.isPending}
                      onClick={() => reveal.mutate(editingCredentialId)}
                    >
                      {t("查看原始 token")}
                    </Button>
                  ) : (
                    <Button size="small" theme="borderless" onClick={() => setRevealed(null)}>
                      {t("隐藏原始 token")}
                    </Button>
                  ))}
              </div>
              <Input
                mode="password"
                value={draft.token}
                placeholder={t(tokenPlaceholderFor(draft.provider, draft.id !== undefined))}
                onChange={(value) => setDraft((current) => (current ? { ...current, token: value } : current))}
              />
              {revealedToken !== null && (
                <div className={styles.revealBlock}>
                  <div className={styles.revealHeader}>
                    <Typography.Text type="tertiary" size="small">
                      {t("这是已保存凭据的明文 token。仅在需要时查看，看完点「隐藏」；不要粘贴到聊天或日志。")}
                    </Typography.Text>
                    <Button size="small" icon={<IconCopy />} onClick={copyRevealedToken}>
                      {t("复制")}
                    </Button>
                  </div>
                  <Typography.Paragraph copyable={false} className={styles.revealToken}>
                    <code>{revealedToken}</code>
                  </Typography.Paragraph>
                </div>
              )}
            </div>
            <div className={styles.field}>
              <label>{t("备注")}</label>
              <Input
                value={draft.note}
                placeholder={t("可选，例如用途或负责人")}
                onChange={(value) => setDraft((current) => (current ? { ...current, note: value } : current))}
              />
            </div>
            <div className={styles.switchRow}>
              <Switch
                checked={draft.enabled}
                onChange={(checked) => setDraft((current) => (current ? { ...current, enabled: checked } : current))}
              />
              <span>{t("启用（停用后 CLI 同步会跳过）")}</span>
            </div>
            <Banner
              type="warning"
              closeIcon={null}
              description={t(
                "保存时会实际请求 {endpoint}；地址不可达或 token 无效时不会落库。内网自签证书请配置可信 CA。",
                { endpoint: checkEndpoint(draft.provider) },
              )}
            />
          </div>
        )}
      </SideSheet>

      {isWebHost && (
        <LocalAccessSideSheet
          visible={accessOpen}
          onClose={() => setAccessOpen(false)}
          credentials={credentials}
          providers={providerOptions}
          credentialsLoading={list.isLoading}
        />
      )}
    </main>
  );
}