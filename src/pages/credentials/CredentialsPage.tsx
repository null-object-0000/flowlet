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
import { IconDelete, IconDownload, IconEdit, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import { credentialCommands } from "../../domains/credentials/commands";
import type {
  CredentialProvider,
  CredentialProviderId,
  ServiceCredential,
} from "../../domains/credentials/types";
import {
  ENV_PREFIX_MAX_LENGTH,
  envKeysForPrefix,
  isValidEnvPrefixInput,
  providerDefaultEnvPrefix,
  resolveEnvPrefix,
} from "../../domains/credentials/envPrefix";
import { LocalAccessSideSheet } from "../../features/credentials/LocalAccessSideSheet";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { isWebHost } from "../../platform/web/mode";
import { PageHeader } from "../../shared/ui/PageHeader";
import { queryKeys } from "../../shared/query-keys";
import { errorMessage } from "../../shared/errors/AppError";
import { formatTimestamp } from "../../shared/formatters/datetime";
import styles from "./CredentialsPage.module.css";

type Draft = {
  id?: string;
  provider: CredentialProviderId;
  name: string;
  baseUrl: string;
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
  token: "",
  note: "",
  enabled: true,
  envPrefix: "",
};

const PROVIDER_LABEL: Record<string, string> = {
  gitlab: "GitLab",
  dockhand: "Dockhand",
};

/** 服务端 provider 元数据加载前/旧 Host 的兜底，保证表单文案马上可用。 */
const FALLBACK_PROVIDERS: CredentialProvider[] = [
  {
    id: "gitlab",
    label: "GitLab",
    baseUrlHint: "https://gitlab.example.com",
    tokenLabel: "Personal Access Token（需要 api scope）",
    available: true,
    defaultEnvPrefix: "GITLAB",
  },
  {
    id: "dockhand",
    label: "Dockhand",
    baseUrlHint: "http://dockhand.example.com:3000",
    tokenLabel: "API Token（Dockhand 设置 → API 令牌）",
    available: true,
    defaultEnvPrefix: "DOCKHAND",
  },
];

/** 保存时实际校验的端点（与两套 Host 的 check 实现一致）。 */
function checkEndpoint(provider: CredentialProviderId): string {
  return provider === "dockhand" ? "Dockhand /api/environments" : "GitLab /api/v4/user";
}

export function CredentialsPage() {
  const { language, t } = useAppPreferences();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);
  /** 「本机接入」引导抽屉：仅 Web Host 可打开。 */
  const [accessOpen, setAccessOpen] = useState(false);

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

  const openCreate = () => {
    setFormError("");
    setDraft({ ...EMPTY_DRAFT });
  };

  const openEdit = (credential: ServiceCredential) => {
    setFormError("");
    setDraft({
      id: credential.id,
      provider: credential.provider === "dockhand" ? "dockhand" : "gitlab",
      name: credential.name,
      baseUrl: credential.baseUrl,
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

  /**
   * Agent 机器上用 `flowlet login` 走浏览器 SSO 授权，再 `flowlet pull` 同步；
   * 页面只展示命令，不收集任何管理凭据。
   */
  const syncCommand = useMemo(() => {
    if (typeof window === "undefined") return "flowlet login --server=<Flowlet 地址>";
    return `flowlet login --server=${window.location.origin}`;
  }, []);

  const credentials = list.data ?? [];
  // 服务端按 gitlab → dockhand 的顺序返回；加载失败/旧 Host 时退回本地兜底定义。
  const providerOptions = providers.data && providers.data.length > 0 ? providers.data : FALLBACK_PROVIDERS;
  const selectedProvider = providerOptions.find((option) => option.id === draft?.provider) ?? FALLBACK_PROVIDERS[0]!;
  const selectedProviderLabel = PROVIDER_LABEL[selectedProvider.id] ?? selectedProvider.label;
  const selectedProviderDefaultEnvPrefix = providerDefaultEnvPrefix(selectedProvider);
  /** 编辑器的环境前缀预览：空值 → provider 默认，非空 → 大写。 */
  const previewPrefix = resolveEnvPrefix(draft?.envPrefix, selectedProviderDefaultEnvPrefix);
  const previewEnvKeys = envKeysForPrefix(previewPrefix);
  /** 前缀示例按 provider 默认前缀展开，提醒用户填写完整前缀而不是只填别名。 */
  const envPrefixExample = `${selectedProviderDefaultEnvPrefix}_NA`;
  const envPrefixInvalid = draft !== null && !isValidEnvPrefixInput(draft.envPrefix);

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
                render: (value: string) => <Typography.Text ellipsis={{ showTooltip: true }}>{value}</Typography.Text>,
              },
              {
                title: t("环境前缀"),
                dataIndex: "envPrefix",
                width: 150,
                render: (_, row) => {
                  const prefix = resolveEnvPrefix(row.envPrefix, defaultEnvPrefixFor(row.provider));
                  const keys = envKeysForPrefix(prefix);
                  return (
                    <Tooltip
                      content={
                        <div className={styles.envKeyTooltip}>
                          <code>{keys.url}</code>
                          <code>{keys.token}</code>
                        </div>
                      }
                    >
                      <Typography.Text code>{prefix}_*</Typography.Text>
                    </Tooltip>
                  );
                },
              },
              {
                title: t("Token"),
                dataIndex: "secretHint",
                width: 130,
                render: (value: string) => <Typography.Text type="tertiary">{value}</Typography.Text>,
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
                width: 230,
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
        onCancel={() => setDraft(null)}
        width={480}
        footer={
          <div className={styles.sheetFooter}>
            <Button onClick={() => setDraft(null)}>{t("取消")}</Button>
            <Button
              theme="solid"
              loading={save.isPending}
              disabled={
                !draft?.name.trim() ||
                !draft?.baseUrl.trim() ||
                (!draft?.id && !draft?.token.trim()) ||
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
            <div className={styles.field}>
              <label>{t("实例地址")}</label>
              <Input
                value={draft.baseUrl}
                placeholder={selectedProvider.baseUrlHint}
                onChange={(value) => setDraft((current) => (current ? { ...current, baseUrl: value } : current))}
              />
            </div>
            <div className={styles.field}>
              <label>{t("环境别名（Env 前缀）")}</label>
              <Input
                value={draft.envPrefix}
                placeholder={t("例如 {example}；留空使用默认 {prefix}", {
                  example: envPrefixExample,
                  prefix: selectedProviderDefaultEnvPrefix,
                })}
                onChange={(value) =>
                  setDraft((current) => (current ? { ...current, envPrefix: value } : current))
                }
              />
              {envPrefixInvalid ? (
                <Typography.Text type="danger" size="small">
                  {t("环境前缀只能包含字母、数字和下划线，且以字母开头（最长 {max} 个字符）", {
                    max: ENV_PREFIX_MAX_LENGTH,
                  })}
                </Typography.Text>
              ) : (
                <Typography.Text type="tertiary" size="small">
                  {t("生成的环境变量：{url} / {token}；请填写完整前缀（如 {example}），同一服务的多实例需使用不同前缀。", {
                    url: previewEnvKeys.url,
                    token: previewEnvKeys.token,
                    example: envPrefixExample,
                  })}
                </Typography.Text>
              )}
            </div>
            <div className={styles.field}>
              <label>{t("Token")}</label>
              <Input
                mode="password"
                value={draft.token}
                placeholder={
                  draft.id
                    ? t("留空表示不修改现有 token")
                    : draft.provider === "dockhand"
                      ? t("粘贴 API Token")
                      : t("粘贴 Personal Access Token")
                }
                onChange={(value) => setDraft((current) => (current ? { ...current, token: value } : current))}
              />
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