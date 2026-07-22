import { useState } from "react";
import { Button, Card, Space, Typography } from "@douyinfe/semi-ui-19";
import { IconPlus } from "@douyinfe/semi-icons";
import { ProxyStatusCard } from "../../features/proxy-lifecycle/ProxyStatusCard";
import { useAccounts, useAccountActions, useChannelPresets, useLatestBalanceSnapshots } from "../../features/channel-accounts";
import { AccountManagementSideSheet, type AccountManagerRequest } from "../../features/channel-accounts/AccountManagementSideSheet";
import { useRouteCandidates } from "../../features/exposed-models/useModels";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useProxyBindConfig } from "../../features/proxy-lifecycle/useProxyBindConfig";
import { OverviewSections } from "./OverviewSections";
import { useProxyOverviewLifecycle } from "../../features/proxy-lifecycle/useProxyOverviewLifecycle";
import { deriveConfigurationStatus } from "../../domains/model/types";
import styles from "./OverviewPage.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Paragraph, Text, Title } = Typography;

/**
 * Next OverviewPage — status summary + onboarding. Per AGENTS.md §7:
 *   - Never shows today's requests / tokens / cost / trends / recent logs.
 *   - Never shows API keys here (only inside the account editor).
 *   - Without accounts, renders proxy status plus the three-step onboarding.
 *   - With accounts, keeps the legacy module split: channel accounts, exposed
 *     models, client access and Agent access.
 */
export function OverviewPage() {
  const { t } = useAppPreferences();
  const accounts = useAccounts();
  const presets = useChannelPresets();
  const accountActions = useAccountActions(presets.data ?? []);
  const modelActions = useModelActions();
  const [accountRequest, setAccountRequest] = useState<AccountManagerRequest | null>(null);
  const routes = useRouteCandidates();
  const bindConfig = useProxyBindConfig();
  const proxy = useProxyOverviewLifecycle(!accounts.isLoading);
  const hasAccounts = (accounts.data?.length ?? 0) > 0;
  const balanceSnapshots = useLatestBalanceSnapshots(hasAccounts);
  const baseUrl = `http://127.0.0.1:${bindConfig.data?.port || 18640}`;
  const configurationStatus = deriveConfigurationStatus(accounts.data ?? [], routes.data ?? []);
  const proxyActionLabel = proxy.status.isError
    ? t("重新读取")
    : proxy.phase === "starting"
      ? t("正在启动…")
      : proxy.phase === "running"
        ? t("重启服务")
        : proxy.phase === "failed"
          ? t("重新启动")
          : t("启动服务");

  const handleProxyAction = () => {
    if (proxy.status.isError) void proxy.status.refetch();
    else void proxy.runPrimaryAction();
  };

  return (
    <main className={styles.page}>
      {proxy.status.isLoading ? <Card>{t("正在读取代理状态…")}</Card> : null}
      {proxy.status.isError ? <Card>{t("读取代理状态失败：{message}", { message: proxy.status.error.message })}</Card> : null}
      {proxy.status.data ? (
        <ProxyStatusCard
          status={proxy.status.data}
          bindConfig={bindConfig.data}
          phase={proxy.phase}
          errorMessage={proxy.error?.message}
          autoStartAttempted={proxy.autoStartAttempted}
          configurationStatus={configurationStatus}
          actionLabel={proxyActionLabel}
          actionBusy={proxy.busy}
          actionDisabled={proxy.status.isLoading || proxy.busy}
          onAction={handleProxyAction}
        />
      ) : null}

      {accounts.isLoading ? <Card>{t("正在加载渠道账号…")}</Card> : null}
      {accounts.isError ? <Card>{t("加载渠道账号失败：{message}", { message: accounts.error.message })}</Card> : null}

      {!accounts.isLoading && !accounts.isError && !hasAccounts ? <Card>
        <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
          <Title heading={4} style={{ margin: 0 }}>
            {t("开始接入")}
          </Title>
          <Paragraph type="tertiary" style={{ margin: 0 }}>
            {t("Flowlet 会在本地启动一个代理，把你的渠道账号安全地提供给 AI 客户端和 Agent 使用。")}
          </Paragraph>

          <div className={styles.steps}>
            <Step n={1} title={t("添加渠道账号")}>
              {t("选择 LongCat、DeepSeek、Kimi 或千问 Qwen，填写 API Key 并测试连接。API Key 仅保存在本地配置中。")}
            </Step>
            <Step n={2} title={t("开放模型")}>
              {t("选择要对外开放的模型。默认开放模型会随账号自动同步。")}
            </Step>
            <Step n={3} title={t("接入 AI 客户端")}>
              {t("在 Claude Code、Cursor、Continue 等工具中填入本地 Base URL 和客户端 Token 即可使用。")}
            </Step>
          </div>

          <Space>
            <Button type="primary" icon={<IconPlus />} onClick={() => setAccountRequest({ kind: "create", channelId: "longcat" })}>
              {t("添加 LongCat")}
            </Button>
            <Button onClick={() => setAccountRequest({ kind: "create", channelId: "deepseek" })}>{t("添加 DeepSeek")}</Button>
            <Button onClick={() => setAccountRequest({ kind: "create", channelId: "kimi" })}>{t("添加 Kimi")}</Button>
            <Button onClick={() => setAccountRequest({ kind: "create", channelId: "qwen" })}>{t("添加千问 Qwen")}</Button>
            <Button type="tertiary" onClick={() => setAccountRequest({ kind: "list" })}>
              {t("管理渠道账号")}
            </Button>
          </Space>
        </Space>
      </Card> : null}

      {hasAccounts && (routes.isLoading || bindConfig.isLoading) ? <Card>{t("正在加载模型和接入配置…")}</Card> : null}
      {hasAccounts && routes.isError ? <Card>{t("加载开放模型失败：{message}", { message: routes.error.message })}</Card> : null}
      {hasAccounts && bindConfig.isError ? <Card>{t("加载客户端配置失败：{message}", { message: bindConfig.error.message })}</Card> : null}

      {hasAccounts && routes.isSuccess && bindConfig.isSuccess ? (
        <OverviewSections
          accounts={accounts.data ?? []}
          channels={presets.data ?? []}
          balanceSnapshots={balanceSnapshots.data ?? []}
          routes={routes.data ?? []}
          baseUrl={baseUrl}
          bindConfig={bindConfig.data}
          proxyRunning={proxy.status.data?.running === true}
          onAccountRequest={setAccountRequest}
          busyModelId={modelActions.toggleExposedModel.isPending ? modelActions.toggleExposedModel.variables?.modelId : undefined}
          onToggleModel={(routeIds, modelId, enabled) => modelActions.toggleExposedModel.mutate({ routes: routes.data ?? [], routeIds, modelId, enabled })}
        />
      ) : null}

      <AccountManagementSideSheet
        request={accountRequest}
        accounts={accounts.data ?? []}
        snapshots={balanceSnapshots.data ?? []}
        presets={presets.data ?? []}
        busy={accountActions.saveAll.isPending || accountActions.testConnection.isPending}
        onClose={() => setAccountRequest(null)}
        onSaveAccounts={(next) => accountActions.saveAll.mutateAsync(next).then(() => undefined)}
        onTestConnection={(input) => accountActions.testConnection.mutateAsync(input)}
        onSaveBalanceSnapshot={(snapshot) => accountActions.saveBalanceSnapshot.mutateAsync(snapshot)}
        onSyncBalance={(accountId) => accountActions.queryBalance.mutateAsync(accountId).then(() => undefined)}
        onScrape={(accountId) => accountActions.scrapeBalance.mutateAsync(accountId).then(() => undefined)}
      />
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className={styles.step}>
      <span className={styles.stepNumber}>{n}</span>
      <Space vertical align="start" spacing="loose">
        <Text strong>{title}</Text>
        <Text type="tertiary" size="small">
          {children}
        </Text>
      </Space>
    </div>
  );
}
