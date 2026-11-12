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
  Tag,
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
import { pickConnectionBaseUrl } from "./connectionBaseUrl";
import { UpstreamProxySettings } from "../pages/settings/UpstreamProxySettings";
import { CaptureSettings } from "../pages/settings/CaptureSettings";
import { UsageCostDisplaySettings } from "../pages/settings/UsageCostDisplaySettings";
import { SettingRow, SettingSection } from "../pages/settings/SettingRow";
import settingsStyles from "../pages/settings/SettingsPage.module.css";
import navStyles from "../pages/settings/SettingsNav.module.css";
import { IconCamera, IconCloud, IconLock, IconSetting } from "@douyinfe/semi-icons";
import { AuthTab } from "../pages/settings/tabs/AuthTab";
import { OverviewServiceStrip } from "../pages/overview/OverviewServiceStrip";
import { OverviewExposedModelsCard } from "../features/exposed-models/OverviewExposedModelsCard";
import { OverviewModuleCard } from "../shared/ui/OverviewModuleCard";
import { modelCommands } from "../domains/model/commands";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { AppProviders } from "../app/providers";
import { WindowControls } from "../app/shell/WindowControls";
import { isDesktopClient } from "../platform/desktop/mode";
import {
  adminToken,
  fetchAuthConfig,
  fetchWebSession,
  logoutWebSession,
  setAdminToken,
  verifyAdminToken,
  invokeWebCommand,
  type WebAuthConfig,
  type WebAuthMode,
  type WebIdentity,
  type WebSession as WebSessionState,
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
import { CredentialsPage } from "../pages/credentials/CredentialsPage";
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
const A2aPage = lazy(() => import("../pages/a2a/A2aPage").then(module => ({ default: module.A2aPage })));

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
const AUTH_ERROR_TEXT: Record<string, string> = {
  access_denied: "你取消了 GitLab 授权",
  allowlist_denied: "当前 GitLab 账号不在允许名单中",
  state_invalid: "登录状态已过期，请重新登录",
  provider_unavailable: "GitLab 暂时不可用，请稍后重试",
  login_failed: "登录失败，请重新尝试",
  session_expired: "登录已过期，请重新登录",
};

function identityLabel(identity?: WebIdentity | null) {
  return identity?.email || identity?.username || identity?.name || "";
}

function WebSession() {
  const qc = useQueryClient();
  const [authConfig, setAuthConfig] = useState<WebAuthConfig | null>(null);
  const [session, setSession] = useState<WebSessionState | null>(null);
  const [authenticated, setAuthenticated] = useState(false);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const logout = async () => {
    if (authConfig?.mode === "oidc") await logoutWebSession();
    else setAdminToken("");
    setSession(null);
    setAuthenticated(false);
    qc.clear();
  };
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const config = await fetchAuthConfig();
        if (!active) return;
        setAuthConfig(config);
        const params = new URLSearchParams(window.location.search);
        const authError = params.get("auth_error");
        if (authError) {
          setError(AUTH_ERROR_TEXT[authError] ?? "登录失败，请重试");
          window.history.replaceState(null, "", "/");
        }
        if (config.mode === "token") {
          const existing = adminToken();
          if (existing) {
            try {
              await verifyAdminToken(existing);
              if (active) {
                setSession({ authenticated: true, mode: "token" });
                setAuthenticated(true);
              }
            } catch {
              if (active) setAdminToken("");
            }
          }
        } else {
          const current = await fetchWebSession();
          if (active && current?.authenticated) {
            setSession(current);
            setAuthenticated(true);
          }
        }
      } catch (e) {
        if (active) setError(e instanceof Error ? e.message : "无法连接管理端");
      } finally {
        if (active) setBusy(false);
      }
    })();
    const expired = () => {
      setAuthenticated(false);
      setSession(null);
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
      setSession({ authenticated: true, mode: "token" });
      setAuthenticated(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  if (busy && !authConfig)
    return (
      <main className={styles.login}>
        <Card title="登录 Flowlet">
          <Typography.Text>正在读取登录配置…</Typography.Text>
        </Card>
      </main>
    );
  if (!authenticated) {
    const oidc = authConfig?.mode === "oidc";
    const providerName = authConfig?.provider.display_name ?? "GitLab";
    // 配了多个提供方（内网 OIDC + 公网 GitHub）就逐个给按钮，不再猜。
    const providers = authConfig?.providers ?? [];
    const loginWith = (id?: string) => {
      if (!authConfig) return;
      const target =
        id === undefined
          ? authConfig.login_path
          : `${authConfig.login_path}?provider=${encodeURIComponent(id)}`;
      window.location.assign(target);
    };
    return (
      <main className={styles.login}>
        <Card title="登录 Flowlet">
          <Space vertical align="start" style={{ width: "100%" }}>
            {error && <Banner type="danger" description={error} />}
            {oidc && providers.length > 1 && (
              <>
                <Typography.Text>选择登录方式：</Typography.Text>
                {providers.map((item) => (
                  <Button key={item.id} theme="solid" onClick={() => loginWith(item.id)}>
                    使用 {item.display_name} 登录
                  </Button>
                ))}
              </>
            )}
            {oidc && providers.length <= 1 && (
              <>
                <Typography.Text>使用 {providerName} 账号登录 Flowlet 管理台。</Typography.Text>
                <Button theme="solid" onClick={() => loginWith()}>
                  使用 {providerName} 登录
                </Button>
              </>
            )}
            {(!oidc || authConfig?.token_login) && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void login();
                }}
              >
                <Space vertical align="start" style={{ width: "100%" }}>
                  <Typography.Text>
                    {oidc ? "或使用部署时设置的管理凭据" : "输入部署时设置的管理凭据"}
                  </Typography.Text>
                  <Input
                    mode="password"
                    value={token}
                    onChange={setToken}
                    aria-label="管理凭据"
                    autoComplete="current-password"
                  />
                  <Button htmlType="submit" theme={oidc ? "borderless" : "solid"} loading={busy}>
                    登录
                  </Button>
                </Space>
              </form>
            )}
          </Space>
        </Card>
      </main>
    );
  }
  return (
    <>
    {isDesktopClient ? <WindowControls /> : null}
    <DesktopAppFrameView
      sidebar={
        <Sidebar
          availableRoutes={[
            "/",
            "/models",
            "/credentials",
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
        <Route path="credentials" element={<CredentialsPage />} />
        <Route path="a2a" element={<Suspense fallback={<WebPageFallback title="A2A 网关" />}><A2aPage /></Suspense>} />
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
        <Route
          path="settings"
          element={
            <WebSettings
              onLogout={() => void logout()}
              identity={session?.identity}
              mode={authConfig?.mode ?? "token"}
            />
          }
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </DesktopAppFrameView>
    </>
  );
}

type WebSettingsTab = "general" | "capture" | "cost" | "network" | "auth";

function WebSettings({
  onLogout,
  identity,
  mode,
}: {
  onLogout: () => void;
  identity?: WebIdentity | null;
  mode: WebAuthMode;
}) {
  const { language, setLanguage, theme, setTheme, t } = useAppPreferences();
  const label = identityLabel(identity);
  const isViewer = identity?.role === "viewer";
  const [tab, setTab] = useState<WebSettingsTab>("general");

  // 二级菜单：与桌面壳「应用设置」同一套结构（左侧分组 + 右侧面板），只保留 Web 端有意义的项。
  const items: Array<{ key: WebSettingsTab; label: string; icon: React.ReactNode }> = [
    { key: "general", label: t("通用"), icon: <IconSetting /> },
    ...(isViewer
      ? []
      : [
          { key: "capture" as const, label: t("数据捕获"), icon: <IconCamera /> },
          { key: "cost" as const, label: t("费用展示"), icon: <IconCloud /> },
          { key: "network" as const, label: t("网络"), icon: <IconCloud /> },
          { key: "auth" as const, label: t("登录与访问"), icon: <IconLock /> },
        ]),
  ];

  const meta: Record<WebSettingsTab, { title: string; desc: string }> = {
    general: { title: t("通用"), desc: t("界面语言、主题与当前登录") },
    capture: { title: t("数据捕获"), desc: t("请求 / 响应内容的捕获与保留策略") },
    cost: { title: t("费用展示"), desc: t("用量页的统一货币折算") },
    network: { title: t("网络"), desc: t("全局请求的代理出口") },
    auth: { title: t("登录与访问"), desc: t("管理台登录方式、准入名单与角色") },
  };

  const generalPanel = (
    <>
      <SettingSection title={t("外观")} note={t("只影响本机浏览器里的显示。")} keywords="语言 主题 外观">
        <SettingRow
          name={t("界面语言")}
          control={
            <Select
              aria-label={t("界面语言")}
              value={language}
              onChange={(value) => setLanguage(value as typeof language)}
              optionList={[
                { value: "zh-CN", label: "简体中文" },
                { value: "en-US", label: "English" },
              ]}
              style={{ width: 200 }}
            />
          }
        />
        <SettingRow
          name={t("界面主题")}
          control={
            <Select
              aria-label={t("界面主题")}
              value={theme}
              onChange={(value) => setTheme(value as typeof theme)}
              optionList={[
                { value: "system", label: "跟随系统" },
                { value: "light", label: "浅色" },
                { value: "dark", label: "深色" },
              ]}
              style={{ width: 200 }}
            />
          }
        />
      </SettingSection>
      <SettingSection title={t("账号")} keywords="登录 账号 退出">
        <SettingRow
          name={t("当前登录")}
          control={
            <Typography.Text type="tertiary">
              {mode === "oidc" && label
                ? `${label}（${identity?.provider ?? "企业 SSO"}${isViewer ? " · 只读" : ""}）`
                : t("管理凭据登录")}
            </Typography.Text>
          }
        />
        {isViewer ? (
          <SettingRow
            name={t("权限")}
            help={t("只读账号可以查看运行情况与用量，不能修改配置、也不能读取服务凭据。需要更高权限请联系管理员把它加进管理员名单。")}
            control={<Tag color="grey">{t("只读")}</Tag>}
          />
        ) : null}
        <SettingRow
          name={t("退出登录")}
          help={t("退出后需要重新通过登录提供方授权。")}
          control={<Button onClick={onLogout}>{t("退出登录")}</Button>}
        />
        {isDesktopClient ? (
          <SettingRow
            name={t("运行模式")}
            help={t("客户端模式只做远程观测与管理；本机 Agent 接入、抓取与跨设备同步不可用。")}
            control={
              <Button onClick={() => void window.flowletDesktop?.openModeSettings?.()}>
                {t("切换运行模式…")}
              </Button>
            }
          />
        ) : null}
      </SettingSection>
    </>
  );

  return (
    <main className={settingsStyles.page} style={{ gridTemplateRows: "minmax(0, 1fr)" }}>
      <section className={settingsStyles.shell}>
        <nav className={navStyles.nav}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`${navStyles.button} ${tab === item.key ? navStyles.active : ""}`}
              data-tab={item.key}
              aria-current={tab === item.key ? "true" : undefined}
              onClick={() => setTab(item.key)}
            >
              <span className={navStyles.icon} aria-hidden="true">
                {item.icon}
              </span>
              {item.label}
            </button>
          ))}
        </nav>
        <article className={settingsStyles.contentPanel}>
          <div className={settingsStyles.panelHead}>
            <div>
              <h2 className={settingsStyles.panelTitle}>{meta[tab].title}</h2>
              <p className={settingsStyles.panelDesc}>{meta[tab].desc}</p>
            </div>
          </div>
          <div className={settingsStyles.panelBody}>
            {tab === "general" ? generalPanel : null}
            {tab === "capture" ? <CaptureSettings /> : null}
            {tab === "cost" ? <UsageCostDisplaySettings /> : null}
            {tab === "network" ? <UpstreamProxySettings /> : null}
            {tab === "auth" ? <AuthTab /> : null}
          </div>
        </article>
      </section>
    </main>
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
      invokeWebCommand<{
        base_url: string;
        base_urls?: string[];
        client_token: string;
      }>("web_connection_info"),
  });
  // 桌面客户端模式：界面由本机网关提供，`window.location.origin` 是本机网关而不是
  // 用户要接入的模型端点，必须回退到“远程主机 + 默认代理端口”而不是本机地址。
  const remoteProxyOrigin = (() => {
    if (!isDesktopClient) return window.location.origin;
    const remote = window.flowletDesktop?.clientBaseUrl ?? "";
    try {
      const url = new URL(remote);
      const host = url.hostname.includes(":") ? `[${url.hostname}]` : url.hostname;
      return `${url.protocol}//${host}:18640`;
    } catch {
      return window.location.origin;
    }
  })();
  const pickedBaseUrl = pickConnectionBaseUrl(
    connection.data?.base_urls,
    connection.data?.base_url,
    remoteProxyOrigin,
  );
  // 远程未配置对外入口（FLOWLET_PUBLIC_PROXY_URL 为空）时，回退到“远程主机 + 默认代理端口”，
  // 不要回退成本机网关地址（那是客户端自己的 origin，用户复制出去连不上）。
  const baseUrl = pickedBaseUrl !== "" ? pickedBaseUrl : remoteProxyOrigin;
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
            proxyScope={isDesktopClient ? "remote" : "local"}
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
