import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { SyncedAgentProfile } from "../domains/device-sync/types";
import { useMobileDeviceAgents } from "../features/device-sync/useMobileDeviceSync";
import { AgentBrandMark } from "../shared/ui/AgentBrandMark";
import styles from "./pages/MobilePage.module.css";

/** 指定设备的已安装 Agent 列表正文，设备二级页复用。下拉刷新与页头由外层壳承载。 */
export function MobileAgentList({ deviceId }: { deviceId: string }) {
  const { t } = useAppPreferences();
  const agents = useMobileDeviceAgents(deviceId);
  const installedAgents = (agents.data ?? []).filter((agent) => agent.installed);

  return (
    <section className={styles.page}>
      {agents.isLoading ? (
        <div className={`${styles.card} ${styles.state}`}><span>{t("正在读取 Agent 状态…")}</span></div>
      ) : null}
      {agents.isError ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("Agent 加载失败")}</strong>
          <span>{agents.error.message}</span>
        </div>
      ) : null}
      {!agents.isLoading && !agents.isError && installedAgents.length === 0 ? (
        <div className={`${styles.card} ${styles.state}`}>
          <strong>{t("未检测到已安装的 Agent")}</strong>
          <span>{t("请先在桌面端执行同步，再在手机端刷新远端数据。")}</span>
        </div>
      ) : null}

      {installedAgents.length > 0 ? (
        <div className={styles.installedAgentList}>
          {installedAgents.map((agent) => <AgentRow key={agent.agentId} agent={agent} />)}
        </div>
      ) : null}
    </section>
  );
}

function AgentRow({ agent }: { agent: SyncedAgentProfile }) {
  const { t } = useAppPreferences();
  const status = agentConnectionStatus(agent, t);
  return (
    <div className={styles.installedAgent}>
      <AgentBrandMark agentId={agent.agentId} />
      <div className={styles.installedAgentMain}>
        <strong>{agent.agentName}</strong>
        <span>{agent.installations.map((installation) => installationLabel(installation, t)).join(" · ")}</span>
      </div>
      <span className={styles.agentConnection} data-state={status.state}>
        <i />{status.label}
      </span>
    </div>
  );
}

type Translate = (source: string, variables?: Record<string, string | number>) => string;

function agentConnectionStatus(agent: SyncedAgentProfile, t: Translate) {
  switch (agent.flowletConfigState) {
    case "flowlet": return { label: t("已接入 Flowlet"), state: "success" };
    case "partial": return { label: t("部分接入 Flowlet"), state: "partial" };
    case "other_gateway": return { label: t("已接入其它网关"), state: "neutral" };
    case "invalid": return { label: t("配置异常"), state: "failed" };
    case "not_configured":
      return agent.flowletObserved
        ? { label: t("近期通过 Flowlet"), state: "observed" }
        : { label: t("未接入 Flowlet"), state: "neutral" };
    default:
      return agent.flowletObserved
        ? { label: t("近期通过 Flowlet"), state: "observed" }
        : { label: t("暂未观测到 Flowlet 请求"), state: "neutral" };
  }
}

function installationLabel(installation: SyncedAgentProfile["installations"][number], t: Translate) {
  const surface = installation.surface === "desktop" ? t("桌面端") : "CLI";
  return installation.version ? `${surface} ${installation.version}` : surface;
}