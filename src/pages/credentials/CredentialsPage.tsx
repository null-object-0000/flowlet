import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banner,
  Button,
  Card,
  Empty,
  Input,
  Modal,
  SideSheet,
  Switch,
  Table,
  Tag,
  Toast,
  Typography,
} from "@douyinfe/semi-ui-19";
import { IconCopy, IconDelete, IconEdit, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import { credentialCommands } from "../../domains/credentials/commands";
import type { ServiceCredential } from "../../domains/credentials/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { PageHeader } from "../../shared/ui/PageHeader";
import { queryKeys } from "../../shared/query-keys";
import { errorMessage } from "../../shared/errors/AppError";
import { formatTimestamp } from "../../shared/formatters/datetime";
import styles from "./CredentialsPage.module.css";

type Draft = {
  id?: string;
  name: string;
  baseUrl: string;
  token: string;
  note: string;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  baseUrl: "",
  token: "",
  note: "",
  enabled: true,
};

const PROVIDER_LABEL: Record<string, string> = {
  gitlab: "GitLab",
};

export function CredentialsPage() {
  const { language, t } = useAppPreferences();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [formError, setFormError] = useState("");
  const [testingId, setTestingId] = useState<string | null>(null);

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
        provider: "gitlab",
        baseUrl: draft?.baseUrl ?? "",
        token: draft?.token.trim() ? draft.token.trim() : undefined,
        kind: "cli_token",
        note: draft?.note.trim() ? draft.note.trim() : undefined,
        enabled: draft?.enabled ?? true,
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
      name: credential.name,
      baseUrl: credential.baseUrl,
      token: "",
      note: credential.note ?? "",
      enabled: credential.enabled,
    });
  };

  const runTest = async (credential: ServiceCredential) => {
    setTestingId(credential.id);
    try {
      const check = await credentialCommands.test(credential.id);
      if (check.ok) {
        const parts = [check.username ? `@${check.username}` : "", check.version ?? ""].filter(
          Boolean,
        );
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

  const syncCommand = useMemo(() => {
    if (typeof window === "undefined") return "flowlet-cred pull --server=<Flowlet 地址>";
    return `flowlet-cred pull --server=${window.location.origin}`;
  }, []);

  const credentials = list.data ?? [];
  const providerOptions = providers.data ?? [];

  return (
    <main className={styles.page}>
      <PageHeader
        title={t("服务凭据")}
        subtitle={t("集中管理 Agent 接入所需的三方服务 token；保存前会实际校验实例与凭据")}
      >
        <Button icon={<IconPlus />} theme="solid" onClick={openCreate}>
          {t("添加凭据")}
        </Button>
      </PageHeader>

      <Banner
        type="info"
        closeIcon={null}
        description={
          <span className={styles.syncHint}>
            {t("Agent 机器上用 CLI 同步到本地 .env：")}
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
            description={t("添加一个 GitLab 实例后，Agent 就能通过 CLI 同步并使用它。")}
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
              disabled={!draft?.name.trim() || !draft?.baseUrl.trim() || (!draft?.id && !draft?.token.trim())}
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
                placeholder={t("例如：公司 GitLab")}
                onChange={(value) => setDraft((current) => (current ? { ...current, name: value } : current))}
              />
            </div>
            <div className={styles.field}>
              <label>{t("服务类型")}</label>
              <Input value={PROVIDER_LABEL.gitlab} disabled />
              <Typography.Text type="tertiary">
                {providerOptions[0]?.tokenLabel ?? t("Personal Access Token（需要 api scope）")}
              </Typography.Text>
            </div>
            <div className={styles.field}>
              <label>{t("实例地址")}</label>
              <Input
                value={draft.baseUrl}
                placeholder="https://gitlab.example.com"
                onChange={(value) => setDraft((current) => (current ? { ...current, baseUrl: value } : current))}
              />
            </div>
            <div className={styles.field}>
              <label>{t("Token")}</label>
              <Input
                mode="password"
                value={draft.token}
                placeholder={draft.id ? t("留空表示不修改现有 token") : t("粘贴 Personal Access Token")}
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
                "保存时会实际请求 GitLab /api/v4/user；地址不可达或 token 无效时不会落库。内网自签证书请配置可信 CA。",
              )}
            />
          </div>
        )}
      </SideSheet>
    </main>
  );
}