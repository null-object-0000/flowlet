import { lazy, Suspense, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Banner,
  Button,
  Card,
  Input,
  Select,
  SideSheet,
  Space,
  Toast,
  Typography,
} from "@douyinfe/semi-ui-19";
import {
  HashRouter,
  Navigate,
  Route,
  Routes,
  useNavigate,
} from "react-router-dom";
import {
  DesktopAppFrameView,
  OverviewGridView,
  OverviewPageView,
} from "@flowlet/product-ui";
import { Sidebar } from "../app/shell/Sidebar";
import { UpstreamProxySettings } from "../pages/settings/UpstreamProxySettings";
import { CaptureSettings } from "../pages/settings/CaptureSettings";
import { UsageCostDisplaySettings } from "../pages/settings/UsageCostDisplaySettings";
import { OverviewServiceStrip } from "../pages/overview/OverviewServiceStrip";
import { OverviewExposedModelsCard } from "../features/exposed-models/OverviewExposedModelsCard";
import { OverviewModuleCard } from "../shared/ui/OverviewModuleCard";
import { modelCommands } from "../domains/model/commands";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { AppProviders } from "../app/providers";
import {
  adminToken,
  setAdminToken,
  verifyAdminToken,
  invokeWebCommand,
} from "../platform/web/client";
import {
  useAccounts,
  useChannelPresets,
  useLatestBalanceSnapshots,
  useAccountActions,
} from "../features/channel-accounts";
import { OverviewChannelAccountsCard } from "../features/channel-accounts/OverviewChannelAccountsCard";
import {
  AccountActionOverlay,
  type AccountActionRequest,
} from "../features/channel-accounts/AccountActionOverlay";
import { ModelServicesPage } from "../pages/models/ModelServicesPage";
import { RequestLogsPage } from "../pages/request-logs/RequestLogsPage";
import { PageHeader } from "../shared/ui/PageHeader";
import { usageCommands } from "../domains/usage/commands";
import { proxyCommands } from "../domains/proxy/commands";
import { queryKeys } from "../shared/query-keys";
import { errorMessage } from "../shared/errors/AppError";
import styles from "./WebApp.module.css";

const UsageCostPage = lazy(() => import("../pages/usage/UsageCostPage").then((module) => ({ default: module.UsageCostPage })));
const UsageAnalysisPage = lazy(() => import("../pages/usage-analysis/UsageAnalysisPage").then((module) => ({ default: module.UsageAnalysisPage })));
// 会话管理在 Web Host 只展示经过本实例的请求观测会话；页面内部按 hostMode="web" 隐藏
// 本机 Agent 原生会话、OpenCode 实时权限与桌面 Agent 数据同步。
const AgentSessionsPage = lazy(() => import("../pages/agent-sessions/AgentSessionsPage").then((module) => ({ default: module.AgentSessionsPage })));

function WebPageFallback({ title }: { title: string }) {
  const { t } = useAppPreferences();
  return (
    <main aria-busy="true">
      <PageHeader title={t(title)} />
    </main>
  );
}

export function WebApp() {
  return (
    <AppProviders>
      <HashRouter>
        <WebSession />
      </HashRouter>
    </AppProviders>
  );
}
function WebSession() {
  const qc = useQueryClient();
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const logout = () => {
    setAdminToken("");
    setAuthenticated(false);
    qc.clear();
  };
  useEffect(() => {
    let active = true;
    const existing = adminToken();
    if (existing)
      void verifyAdminToken(existing)
        .then(() => {
          if (active) setAuthenticated(true);
        })
        .catch(() => {
          if (active) setAdminToken("");
        });
    const expired = () => {
      setAuthenticated(false);
      qc.clear();
    };
    window.addEventListener("flowlet-web-unauthorized", expired);
    return () => {
      active = false;
      window.removeEventListener("flowlet-web-unauthorized", expired);
    };
  }, [qc]);
  const login = async () => {
    setBusy(true);
    setError("");
    try {
      await verifyAdminToken(token);
      setAdminToken(token);
      setToken("");
      setAuthenticated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  if (!authenticated)
    return (
      <main className={styles.login}>
        <Card title="登录 Flowlet">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void login();
            }}
          >
            <Space vertical align="start" style={{ width: "100%" }}>
              <Typography.Text>输入部署时设置的管理凭据</Typography.Text>
              <Input
                mode="password"
                value={token}
                onChange={setToken}
                aria-label="管理凭据"
                autoComplete="current-password"
              />
              {error && <Banner type="danger" description={error} />}
              <Button htmlType="submit" theme="solid" loading={busy}>
                登录
              </Button>
            </Space>
          </form>
        </Card>
      </main>
    );
  return (
    <DesktopAppFrameView
      sidebar={
        <Sidebar
          availableRoutes={[
            "/",
            "/models",
            "/logs",
            "/sessions",
            "/usage",
            "/usage-analysis",
          ]}
        />
      }
    >
      <Routes>
        <Route index element={<WebAccounts />} />
        <Route path="overview" element={<Navigate to="/" replace />} />
        <Route path="accounts" element={<Navigate to="/" replace />} />
        <Route path="models" element={<ModelServicesPage />} />
        <Route path="logs" element={<RequestLogsPage />} />
        <Route
          path="sessions"
          element={(
            <Suspense fallback={<WebPageFallback title="会话管理" />}>
              <AgentSessionsPage hostMode="web" />
            </Suspense>
          )}
        />
        <Route
          path="usage"
          element={(
            <Suspense fallback={<WebPageFallback title="用量统计" />}>
              <UsageCostPage />
            </Suspense>
          )}
        />
        <Route
          path="usage-analysis"
          element={(
            <Suspense fallback={<WebPageFallback title="用量洞察" />}>
              <UsageAnalysisPage />
            </Suspense>
          )}
        />
        <Route path="settings" element={<WebSettings onLogout={logout} />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DesktopAppFrameView>
  );
}

function WebSettings({ onLogout }: { onLogout: () => void }) {
  const { language, setLanguage, theme, setTheme, t } = useAppPreferences();
  return (
    <>
    <Card title={t("应用设置")}>
      <Space wrap>
        <Select
          aria-label="界面语言"
          value={language}
          onChange={(value) => setLanguage(value as typeof language)}
          optionList={[
            { value: "zh-CN", label: "简体中文" },
            { value: "en-US", label: "English" },
          ]}
        />
        <Select
          aria-label="界面主题"
          value={theme}
          onChange={(value) => setTheme(value as typeof theme)}
          optionList={[
            { value: "system", label: "跟随系统" },
            { value: "light", label: "浅色" },
            { value: "dark", label: "深色" },
          ]}
        />
        <Button onClick={onLogout}>退出登录</Button>
      </Space>
    </Card>
    <CaptureSettings />
    <UsageCostDisplaySettings />
    <UpstreamProxySettings />
    </>
  );
}

function WebAccounts() {
  const accountsQuery = useAccounts();
  const presetsQuery = useChannelPresets();
  const accounts = accountsQuery.data ?? [];
  const presets = presetsQuery.data ?? [];
  // headless / Docker Host 由服务端每 5 分钟同步官方余额，页面按分钟拉取最新快照。
  const snapshotsQuery = useLatestBalanceSnapshots(accounts.length > 0, 60_000);
  const actions = useAccountActions(presets);
  const [request, setRequest] = useState<AccountActionRequest | null>(null);
  const navigate = useNavigate();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const routes = useQuery({
    queryKey: queryKeys.model.candidates(),
    queryFn: modelCommands.listRouteCandidates,
  });
  const today = useQuery({
    queryKey: ["web", "usage-today"],
    queryFn: usageCommands.todayTokens,
    refetchInterval: 30000,
  });
  const status = useQuery({
    queryKey: ["web", "proxy"],
    queryFn: proxyCommands.status,
    refetchInterval: 5000,
  });
  const connection = useQuery({
    queryKey: ["web", "connection"],
    queryFn: () =>
      invokeWebCommand<{ base_url: string; client_token: string }>(
        "web_connection_info",
      ),
  });
  const baseUrl =
    connection.data?.base_url ||
    `${window.location.protocol}//${window.location.hostname.includes(":") ? `[${window.location.hostname}]` : window.location.hostname}:18640`;
  const failure =
    accountsQuery.error ||
    presetsQuery.error ||
    connection.error ||
    status.error;
  const report = (e: unknown) => Toast.error(errorMessage(e));
  const running = status.data?.running === true;
  const startOrRestart = async () => {
    setRestarting(true);
    try {
      await (running ? proxyCommands.restart() : proxyCommands.start());
    } catch (error) {
      report(error);
    } finally {
      await status.refetch();
      setRestarting(false);
    }
  };
  return (
    <OverviewPageView
      service={
        <>
          {failure && (
            <Banner type="danger" description={errorMessage(failure)} />
          )}
          <OverviewServiceStrip
            status={status.data}
            phase={
              restarting
                ? "starting"
                : running
                  ? "running"
                  : status.isError
                    ? "failed"
                    : "stopped"
            }
            bindConfig={
              connection.data
                ? {
                    host: "",
                    port: 0,
                    allow_lan: true,
                    default_client_token: connection.data.client_token,
                  }
                : undefined
            }
            baseUrl={baseUrl}
            todayUsage={today.data ?? null}
            onOpenUsage={() => navigate("/usage")}
            onOpenDetails={() => setDetailsOpen(true)}
            showConnectionTest={false}
          />
        </>
      }
    >
      <OverviewGridView
        accounts={
          <OverviewChannelAccountsCard
            accounts={accounts}
            channels={presets}
            desktopCapabilities={false}
            snapshots={snapshotsQuery.data ?? []}
            busy={actions.saveAll.isPending}
            onCreate={(channelId) => setRequest({ kind: "create", channelId })}
            onEdit={(accountId) => setRequest({ kind: "edit", accountId })}
            onDelete={(accountId) => setRequest({ kind: "delete", accountId })}
            onToggle={(id, enabled) => {
              void actions.saveAll
                .mutateAsync(
                  accounts.map((a) => (a.id === id ? { ...a, enabled } : a)),
                )
                .catch(report);
            }}
          />
        }
        models={
          <OverviewExposedModelsCard
            routes={routes.data ?? []}
            accounts={accounts}
            channels={presets}
            onManage={() => navigate("/models")}
            onOpenModel={(id) =>
              navigate(`/models?model=${encodeURIComponent(id)}`)
            }
          />
        }
        agents={
          <OverviewModuleCard title="AI Agent 接入">
            <p>从客户端填写对应协议的 Base URL 和客户端 Token。</p>
            <Button onClick={() => setDetailsOpen(true)}>接入详情</Button>
          </OverviewModuleCard>
        }
      />
      <SideSheet
        title="接入详情"
        visible={detailsOpen}
        onCancel={() => setDetailsOpen(false)}
      >
        <p>OpenAI Base URL</p>
        <Typography.Text copyable>{baseUrl}/v1</Typography.Text>
        <p>Anthropic Base URL</p>
        <Typography.Text copyable>{baseUrl}/anthropic</Typography.Text>
        <p>Responses API</p>
        <Typography.Text copyable>{baseUrl}/v1/responses</Typography.Text>
        <p>
          <Button loading={restarting} onClick={() => void startOrRestart()}>
            {running ? "重启服务" : "启动服务"}
          </Button>
        </p>
      </SideSheet>
      <AccountActionOverlay
        request={request}
        accounts={accounts}
        presets={presets.map((preset) => ({
          ...preset,
          supports_scrape_balance: false,
        }))}
        desktopCapabilities={false}
        snapshots={snapshotsQuery.data ?? []}
        busy={actions.saveAll.isPending}
        onClose={() => setRequest(null)}
        onSaveAccounts={async (next) => {
          await actions.saveAll.mutateAsync(next);
        }}
        onTestConnection={async (input) => {
          await actions.testConnection.mutateAsync(input);
        }}
        onSaveBalanceSnapshot={async (snapshot) => {
          await actions.saveBalanceSnapshot.mutateAsync(snapshot);
        }}
        onSyncBalance={(id) => actions.queryBalance.mutateAsync(id)}
        onScrape={async () => {
          throw new Error(
            "浏览器抓取与本机授权请使用 Flowlet 桌面端；Web 支持 API Key 渠道",
          );
        }}
      />
    </OverviewPageView>
  );
}
