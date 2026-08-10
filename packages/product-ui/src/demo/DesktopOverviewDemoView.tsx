import { useState } from "react";
import { Button, Switch } from "@douyinfe/semi-ui-19";
import { IconMore, IconPlus } from "@douyinfe/semi-icons";
import {
  OverviewAgentListView,
  OverviewAgentRowView,
  OverviewGridView,
  OverviewListRowView,
  OverviewListView,
  OverviewModuleCardView,
  OverviewPageView,
  OverviewStatusPillView,
} from "../desktop/OverviewLayoutViews";
import { ChannelBrandLogoView } from "../desktop/ChannelBrandLogoView";
import { OverviewServiceStripView } from "../desktop/OverviewServiceStripView";
import { createOverviewServiceFixture } from "./fixtures";
import styles from "./DesktopOverviewDemoView.module.css";

type DemoAccount = {
  id: string;
  channelId: string;
  name: string;
  nameMeta?: string;
  summary?: string;
  secondary?: string;
  enabled: boolean;
  observable?: boolean;
  synced?: boolean;
};

const ACCOUNTS: DemoAccount[] = [
  { id: "deepseek-work", channelId: "deepseek", name: "DeepSeek · 工作账号", summary: "余额 10.23 CNY", enabled: true, synced: true },
  { id: "kimi-work", channelId: "kimi", name: "Kimi · 主账号", summary: "余额 13.75 CNY", enabled: true, synced: true },
  { id: "longcat-pack", channelId: "longcat", name: "LongCat · 资源包", nameMeta: "有效期至 2026-08-25", summary: "余额 0.00 CNY", secondary: "资源包 31.72万 Tokens", enabled: true, synced: true },
  { id: "openrouter", channelId: "openrouter", name: "OpenRouter · 中转账号", enabled: true, synced: true },
  { id: "qwen-plan", channelId: "qwen", name: "Qwen · Token Plan", nameMeta: "个人版 Standard 套餐", summary: "7天剩余 42.0%", secondary: "2026/08/11 10:06:00", enabled: true },
  { id: "qwen-payg", channelId: "qwen", name: "Qwen · 按量付费", enabled: true },
  { id: "zhipu", channelId: "zhipu", name: "Z.AI · 开发账号", enabled: true },
  { id: "disabled-deepseek", channelId: "deepseek", name: "DeepSeek · 备用账号", summary: "余额 6.20 CNY", enabled: false },
  { id: "disabled-kimi", channelId: "kimi", name: "Kimi · 备用账号", enabled: false },
  { id: "disabled-qwen", channelId: "qwen", name: "Qwen · 备用账号", enabled: false },
  { id: "disabled-longcat", channelId: "longcat", name: "LongCat · 备用账号", enabled: false },
  { id: "codex-demo", channelId: "chatgpt", name: "demo@flowlet.local", nameMeta: "Plus", summary: "7天剩余 64%", secondary: "2026/08/16 10:05:30", enabled: true, observable: true, synced: true },
];

const AGENTS = [
  { name: "Claude Code", icon: "claudecode.svg", tone: "claude" as const, surfaces: [{ label: "CLI", zh: "2.1.226", en: "2.1.226" }] },
  { name: "OpenCode", icon: "opencode.svg", surfaces: [{ label: "CLI", zh: "未安装", en: "Not installed" }, { label: "Desktop", zh: "未安装", en: "Not installed" }] },
  { name: "Pi", icon: "pi.svg", surfaces: [{ label: "CLI", zh: "未安装", en: "Not installed" }] },
  { name: "Codex", icon: "openai.svg", surfaces: [{ label: "CLI", zh: "0.147.0", en: "0.147.0" }, { label: "Desktop", zh: "26.803.5235.0", en: "26.803.5235.0" }] },
];

export function DesktopOverviewDemoView({ zh, density = "default", onOpenUsage }: { zh: boolean; density?: "default" | "compact"; onOpenUsage?: () => void }) {
  const service = createOverviewServiceFixture(zh);
  const [showDisabled, setShowDisabled] = useState(false);
  const visibleAccounts = ACCOUNTS.filter((account) => account.observable || account.enabled || showDisabled);

  const logo = (account: DemoAccount) => (
    <span className={styles.logoWrap}>
      <ChannelBrandLogoView channelId={account.channelId} name={account.name} />
      {account.synced ? <i aria-hidden="true" /> : null}
    </span>
  );

  return (
    <OverviewPageView service={<OverviewServiceStripView
      density={density}
      model={service.model}
      labels={service.labels}
      onOpenUsage={onOpenUsage}
      onOpenDetails={() => undefined}
      onCopy={(value) => navigator.clipboard?.writeText(value)}
      onTest={() => new Promise((resolve) => window.setTimeout(resolve, 450))}
    />}>
      <OverviewGridView
        accounts={<OverviewModuleCardView
          title={zh ? "渠道账号" : "Model accounts"}
          meta={zh ? "已启用 7 / 共 11 个账号" : "7 of 11 enabled"}
          headerExtra={<div className={styles.accountActions}>
            <label><span>{zh ? "显示停用账号" : "Show disabled"}</span><Switch size="small" checked={showDisabled} onChange={setShowDisabled} /></label>
            <button type="button" className={styles.linkAction}><IconPlus />{zh ? "新增账号" : "Add account"}</button>
          </div>}
        >
          <OverviewListView>{visibleAccounts.map((account) => (
            <OverviewListRowView
              key={account.id}
              logo={logo(account)}
              title={<span className={styles.titleLine}><span>{account.name}</span>{account.nameMeta ? <><i>·</i><small>{account.nameMeta}</small></> : null}</span>}
              subtitle={account.summary || account.secondary ? <span className={styles.summaryLine}><span>{account.summary}</span>{account.secondary ? <><i>·</i><span>{account.secondary}</span></> : null}</span> : undefined}
              onClick={() => undefined}
              trailing={account.observable ? null : <OverviewStatusPillView tone={account.enabled ? "success" : "muted"}>{zh ? (account.enabled ? "启用" : "停用") : (account.enabled ? "Enabled" : "Disabled")}</OverviewStatusPillView>}
              actions={account.observable ? null : <Button theme="borderless" icon={<IconMore />} aria-label={zh ? `账号操作：${account.name}` : `Account actions: ${account.name}`} />}
            />
          ))}</OverviewListView>
        </OverviewModuleCardView>}
        models={<OverviewModuleCardView title={zh ? "聚合模型" : "Aggregate models"} meta={zh ? "共 2 个聚合模型" : "2 aggregate models"} action={zh ? "管理模型" : "Manage"}>
          <OverviewListView>
            <OverviewListRowView logo={<img src="/flowlet-logo.png" alt="" />} title={<span className={styles.titleLine}><span>flowlet-pro</span><small>{zh ? "能力优先" : "Capability first"}</small></span>} subtitle={zh ? "2 / 2 个模型可用 · 2 / 2 个账号可用" : "2 / 2 models · 2 / 2 accounts"} trailing={<OverviewStatusPillView>{zh ? "可用" : "Ready"}</OverviewStatusPillView>} />
            <OverviewListRowView logo={<img src="/flowlet-logo.png" alt="" />} title={<span className={styles.titleLine}><span>flowlet-flash</span><small>{zh ? "速度优先" : "Speed first"}</small></span>} subtitle={zh ? "4 / 4 个模型可用 · 3 / 3 个账号可用" : "4 / 4 models · 3 / 3 accounts"} trailing={<OverviewStatusPillView>{zh ? "可用" : "Ready"}</OverviewStatusPillView>} />
          </OverviewListView>
        </OverviewModuleCardView>}
        agents={<OverviewModuleCardView title={zh ? "AI Agent 接入" : "AI agent access"}>
          <OverviewAgentListView>{AGENTS.map((agent) => <OverviewAgentRowView
            key={agent.name}
            name={agent.name}
            iconSrc={`/icons/lobe/${agent.icon}`}
            tone={agent.tone}
            surfaces={agent.surfaces.map((surface) => ({ label: surface.label, value: zh ? surface.zh : surface.en }))}
            onClick={() => undefined}
            ariaLabel={zh ? `配置 ${agent.name}` : `Configure ${agent.name}`}
          />)}</OverviewAgentListView>
        </OverviewModuleCardView>}
      />
    </OverviewPageView>
  );
}
