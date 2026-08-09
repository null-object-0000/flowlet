import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, Toast } from "@douyinfe/semi-ui-19";
import { ApiAccessSideSheet } from "../../features/client-access/ApiAccessSideSheet";
import { useAccounts, useAccountActions, useChannelPresets, useLatestBalanceSnapshots } from "../../features/channel-accounts";
import { useCodexAccounts, useCodexAccountRefreshOne, useCodexAccountAuthorization } from "../../features/agent-access/useAgentEnvironment";
import { AccountActionOverlay, type AccountActionRequest } from "../../features/channel-accounts/AccountActionOverlay";
import { CodexAccountSideSheet } from "../../features/channel-accounts/CodexAccountSideSheet";
import { useRouteCandidates } from "../../features/exposed-models/useModels";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useProxyBindConfig } from "../../features/proxy-lifecycle/useProxyBindConfig";
import { useProxyOverviewLifecycle } from "../../features/proxy-lifecycle/useProxyOverviewLifecycle";
import { useTodayTokens } from "../../features/usage/useTodayTokens";
import { OverviewGrid } from "./OverviewGrid";
import { OverviewServiceStrip } from "./OverviewServiceStrip";
import styles from "./OverviewPage.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { errorMessage } from "../../shared/errors/AppError";

export function OverviewPage() {
  const { t } = useAppPreferences();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const presets = useChannelPresets();
  const accountActions = useAccountActions(presets.data ?? []);
  const modelActions = useModelActions();
  const [accountRequest, setAccountRequest] = useState<AccountActionRequest | null>(null);
  const [detailsVisible, setDetailsVisible] = useState(false);
  const routes = useRouteCandidates();
  const bindConfig = useProxyBindConfig();
  const proxy = useProxyOverviewLifecycle(!accounts.isLoading);
  const hasAccounts = (accounts.data?.length ?? 0) > 0;
  const balanceSnapshots = useLatestBalanceSnapshots(hasAccounts);
  const codexAccounts = useCodexAccounts(hasAccounts);
  const codexAccountRefreshOne = useCodexAccountRefreshOne();
  const codexAccountAuthorization = useCodexAccountAuthorization();
  const [codexSheetVisible, setCodexSheetVisible] = useState(false);
  const [focusedCodexAccount, setFocusedCodexAccount] = useState<string | undefined>(undefined);
  const baseUrl = `http://127.0.0.1:${bindConfig.data?.port || 18640}`;

  const toggleAccount = async (accountId: string, enabled: boolean) => {
    const current = accounts.data ?? [];
    const target = current.find((account) => account.id === accountId);
    if (!target) return;
    try {
      await accountActions.saveAll.mutateAsync(
        current.map((account) => account.id === accountId ? { ...account, enabled } : account),
      );
      Toast.success(t(enabled ? "账号已启用" : "账号已停用"));
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  const authorizeCodexAccount = async () => {
    try {
      const report = await codexAccountAuthorization.mutateAsync();
      await codexAccounts.refetch();
      setFocusedCodexAccount(report.account_id);
      Toast.success(t("Codex 账号授权成功"));
    } catch (error) {
      Toast.error(t("Codex 账号授权失败：{message}", { message: errorMessage(error) }));
    }
  };

  // 新增抽屉里的 ChatGPT 授权：不自行弹 Toast，由抽屉负责成功关闭/失败提示。
  const authorizeChatGptFromDrawer = async () => {
    await codexAccountAuthorization.mutateAsync();
    await codexAccounts.refetch();
  };

  // 概览页顶部「今日消耗」仍使用单条聚合 command，但后端口径与用量统计页
  // 的「日 / 全部设备」一致：本机代理 + 本机 Agent 原生 + 其他设备快照。
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
        onOpenUsage={() => navigate("/usage")}
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
          onToggleAccount={(accountId, enabled) => void toggleAccount(accountId, enabled)}
          accountActionBusy={accountActions.saveAll.isPending}
          onOpenCodexAgent={(accountId) => {
            setFocusedCodexAccount(accountId || undefined);
            setCodexSheetVisible(true);
          }}
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

      <AccountActionOverlay
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
        onAuthorizeChatGpt={authorizeChatGptFromDrawer}
        authorizationBusy={codexAccountAuthorization.isPending}
      />

      {focusedCodexAccount ? (
        <CodexAccountSideSheet
          visible={codexSheetVisible}
          accounts={codexAccounts.data}
          accountId={focusedCodexAccount}
          accountLoading={codexAccountRefreshOne.isPending}
          accountError={codexAccountRefreshOne.error?.message}
          onRefreshAccount={() => void codexAccountRefreshOne.mutate(focusedCodexAccount)}
          accountAuthorizationBusy={codexAccountAuthorization.isPending}
          onAuthorizeAccount={() => void authorizeCodexAccount()}
          onClose={() => {
            setCodexSheetVisible(false);
            setFocusedCodexAccount(undefined);
          }}
        />
      ) : null}
    </main>
  );
}
