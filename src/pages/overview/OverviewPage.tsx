import { useState } from "react";
import { Card } from "@douyinfe/semi-ui-19";
import { ApiAccessSideSheet } from "../../features/client-access/ApiAccessSideSheet";
import { useAccounts, useAccountActions, useChannelPresets, useLatestBalanceSnapshots } from "../../features/channel-accounts";
import { useCodexAccounts } from "../../features/agent-access/useAgentEnvironment";
import { AccountManagementSideSheet, type AccountManagerRequest } from "../../features/channel-accounts/AccountManagementSideSheet";
import { useRouteCandidates } from "../../features/exposed-models/useModels";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useProxyBindConfig } from "../../features/proxy-lifecycle/useProxyBindConfig";
import { useProxyOverviewLifecycle } from "../../features/proxy-lifecycle/useProxyOverviewLifecycle";
import { useTodayTokens } from "../../features/usage/useTodayTokens";
import { OverviewGrid } from "./OverviewGrid";
import { OverviewServiceStrip } from "./OverviewServiceStrip";
import styles from "./OverviewPage.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

export function OverviewPage() {
  const { t } = useAppPreferences();
  const accounts = useAccounts();
  const presets = useChannelPresets();
  const accountActions = useAccountActions(presets.data ?? []);
  const modelActions = useModelActions();
  const [accountRequest, setAccountRequest] = useState<AccountManagerRequest | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const routes = useRouteCandidates();
  const bindConfig = useProxyBindConfig();
  const proxy = useProxyOverviewLifecycle(!accounts.isLoading);
  const hasAccounts = (accounts.data?.length ?? 0) > 0;
  const balanceSnapshots = useLatestBalanceSnapshots(hasAccounts);
  const codexAccounts = useCodexAccounts(hasAccounts);
  const baseUrl = `http://127.0.0.1:${bindConfig.data?.port || 18640}`;

  // 概览页顶部「今日消耗」：用专用轻量接口，拉今日 Token 聚合（总量 + 输入/
  // 输出/缓存拆解，单条聚合行），供总数展示与悬浮明细。不要复用
  // useUsageSummary —— 那个拉全量分组明细，每 30s 卡窗口拖动。
  const { summary: todayUsage } = useTodayTokens(true);

  return (
    <main className={styles.page}>
      {proxy.status.isLoading ? <Card>{t("正在读取代理状态…")}</Card> : null}
      {proxy.status.isError ? <Card>{t("读取代理状态失败：{message}", { message: proxy.status.error.message })}</Card> : null}

      <OverviewServiceStrip
        status={proxy.status.data}
        phase={proxy.phase}
        bindConfig={bindConfig.data}
        baseUrl={baseUrl}
        todayUsage={todayUsage}
        onOpenDetails={() => setDetailsVisible(true)}
      />

      {accounts.isLoading ? <Card>{t("正在加载渠道账号…")}</Card> : null}
      {accounts.isError ? <Card>{t("加载渠道账号失败：{message}", { message: accounts.error.message })}</Card> : null}

      {hasAccounts && (routes.isLoading || bindConfig.isLoading) ? <Card>{t("正在加载模型和接入配置…")}</Card> : null}
      {hasAccounts && routes.isError ? <Card>{t("加载开放模型失败：{message}", { message: routes.error.message })}</Card> : null}
      {hasAccounts && bindConfig.isError ? <Card>{t("加载客户端配置失败：{message}", { message: bindConfig.error.message })}</Card> : null}

      {!accounts.isLoading && !accounts.isError ? (
        <OverviewGrid
          accounts={accounts.data ?? []}
          channels={presets.data ?? []}
          balanceSnapshots={balanceSnapshots.data ?? []}
          codexAccounts={codexAccounts.data?.accounts}
          routes={routes.data ?? []}
          baseUrl={baseUrl}
          bindConfig={bindConfig.data}
          onAccountRequest={setAccountRequest}
          busyModelId={modelActions.toggleExposedModel.isPending ? modelActions.toggleExposedModel.variables?.modelId : undefined}
          onToggleModel={(routeIds, modelId, enabled) => modelActions.toggleExposedModel.mutate({ routes: routes.data ?? [], routeIds, modelId, enabled })}
        />
      ) : null}

      {bindConfig.data ? (
        <ApiAccessSideSheet
          visible={detailsVisible}
          onClose={() => setDetailsVisible(false)}
          baseUrl={baseUrl}
          bindConfig={bindConfig.data}
          running={proxy.status.data?.running === true}
          onCopy={async (value, message) => {
            try {
              await navigator.clipboard.writeText(value);
            } catch {
              // ignore clipboard errors, message still shows intent
            }
          }}
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
        onScrape={(accountId) => accountActions.scrapeBalance.mutateAsync(accountId)}
      />
    </main>
  );
}
