import { useState, type ReactNode } from "react";
import { IconChevronLeft, IconChevronRight, IconComment, IconDesktop, IconHome, IconList, IconRefresh, IconSetting } from "@douyinfe/semi-icons";
import { Button, Select } from "@douyinfe/semi-ui-19";
import { MobileAppFrameView, type MobileNavItem } from "../mobile/MobileAppFrameView";
import {
  MobileCardView,
  MobileDeviceListView,
  MobilePageHeaderView,
  MobilePageView,
  MobileTaskBoardView,
  mobileProductViewStyles as pageStyles,
  type MobileDeviceRowModel,
  type MobileTaskRowModel,
} from "../mobile/MobileProductViews";
import { UsageSummaryGridView } from "../mobile/UsageSummaryGridView";
import styles from "./MobileCompanionDemoView.module.css";

type MobilePage = "overview" | "projects" | "devices" | "settings";
type Copy = {
  eyebrow: string;
  title: string;
  description: string;
  nav: Record<MobilePage, string>;
  features: Array<{ id: MobilePage; title: string; description: string }>;
};

const copy: Record<"zh" | "en", Copy> = {
  zh: {
    eyebrow: "移动辅助端",
    title: "离开电脑，也能掌握 Agent 正在做什么。",
    description: "连接你自己的同步存储，在手机上汇总多台 Flowlet 设备；回到局域网后，还能把任务直接交给目标设备。",
    nav: { overview: "概览", projects: "项目", devices: "设备", settings: "设置" },
    features: [
      { id: "overview", title: "跨设备用量", description: "按设备查看 Token、请求量、缓存和费用。" },
      { id: "devices", title: "会话与 Agent", description: "查看各设备的会话状态、已安装 Agent 与接入情况。" },
      { id: "projects", title: "移动处理任务", description: "在局域网内提交项目任务，并处理 Agent 交互确认。" },
      { id: "settings", title: "同步由你掌控", description: "使用自己的 S3-compatible 存储连接多台设备。" },
    ],
  },
  en: {
    eyebrow: "Mobile companion",
    title: "Stay on top of your agents away from your desk.",
    description: "Connect your own sync storage to bring multiple Flowlet devices together, then send work to a target device on the same LAN.",
    nav: { overview: "Overview", projects: "Projects", devices: "Devices", settings: "Settings" },
    features: [
      { id: "overview", title: "Cross-device usage", description: "See tokens, requests, cache, and cost by device." },
      { id: "devices", title: "Sessions and agents", description: "Inspect sessions, installed agents, and connection status." },
      { id: "projects", title: "Handle work on mobile", description: "Submit project tasks and respond to agent confirmations over LAN." },
      { id: "settings", title: "Your sync, your control", description: "Connect devices through your own S3-compatible storage." },
    ],
  },
};

const pageIcons: Record<MobilePage, ReactNode> = { overview: <IconHome />, projects: <IconList />, devices: <IconDesktop />, settings: <IconSetting /> };

export function MobileCompanionDemoView({ zh = true }: { zh?: boolean; logoSrc?: string }) {
  const text = copy[zh ? "zh" : "en"];
  const [activePage, setActivePage] = useState<MobilePage>("overview");
  const navItems: MobileNavItem[] = (Object.keys(text.nav) as MobilePage[]).map((id) => ({ id, href: `#mobile-${id}`, label: text.nav[id], icon: pageIcons[id] }));
  return <div className={styles.canvas}>
    <section className={styles.intro}>
      <span className={styles.eyebrow}>{text.eyebrow}</span><h3>{text.title}</h3><p>{text.description}</p>
      <div className={styles.featureList}>{text.features.map((feature) => <button key={feature.id} type="button" className={styles.feature} data-active={activePage === feature.id} onClick={() => setActivePage(feature.id)}><span>{pageIcons[feature.id]}</span><span><strong>{feature.title}</strong><small>{feature.description}</small></span></button>)}</div>
    </section>
    <div className={styles.phoneStage}><div className={styles.phone}>
      <div className={styles.phoneTop}><span>9:41</span><i /><b /></div>
      <MobileAppFrameView embedded items={navItems} activeId={activePage} navigationLabel={zh ? "主导航" : "Main navigation"} onNavigate={(id) => setActivePage(id as MobilePage)}>
        {activePage === "overview" ? <OverviewDemoPage zh={zh} /> : null}
        {activePage === "projects" ? <ProjectsDemoPage zh={zh} /> : null}
        {activePage === "devices" ? <DevicesDemoPage zh={zh} /> : null}
        {activePage === "settings" ? <SettingsDemoPage zh={zh} /> : null}
      </MobileAppFrameView>
    </div></div>
  </div>;
}

function OverviewDemoPage({ zh }: { zh: boolean }) {
  return <MobilePageView>
    <MobilePageHeaderView picker title={zh ? "全部概览" : "All devices"} meta={<small className={styles.lastRefresh}>{zh ? "刚刚刷新" : "Just refreshed"}</small>} subtitle={zh ? "按设备和时间查看 Token 使用规模与活跃节奏" : "Explore token usage and activity by device and time"} />
    <div className={pageStyles.overviewFilters}>
      <div className={pageStyles.periodTabs}>{[zh ? "日" : "Day", zh ? "周" : "Week", zh ? "月" : "Month"].map((label, index) => <button key={label} type="button" aria-pressed={index === 1}>{label}</button>)}</div>
      <div className={pageStyles.periodToolbar}><div className={pageStyles.rangeNavigator}><Button theme="borderless" size="small" icon={<IconChevronLeft />} /><strong>{zh ? "8月10日–8月16日" : "Aug 10–Aug 16"}</strong><Button theme="borderless" size="small" icon={<IconChevronRight />} disabled /></div></div>
    </div>
    <UsageSummaryGridView items={[
      { id: "tokens", label: "Tokens", value: zh ? "2.54亿" : "254M", detail: zh ? "输入 2.54亿 · 输出 102.85万" : "253M input · 1.03M output" },
      { id: "requests", label: zh ? "请求量" : "Requests", value: "1,855", detail: zh ? "代理 1,033 · 原生 822" : "1,033 proxy · 822 native" },
      { id: "cache", label: zh ? "缓存输入" : "Cached input", value: zh ? "2.46亿" : "246M", detail: zh ? "缓存命中率 97.1%" : "97.1% hit rate" },
      { id: "cost", label: zh ? "预估费用" : "Est. cost", value: "¥9.5113", detail: zh ? "Flowlet 可统计用量" : "Flowlet-attributed usage" },
    ]} />
    <MobileCardView><div className={pageStyles.cardHeader}><div><strong>{zh ? "星期 × 小时 Token 热力图" : "Weekday × hour token heatmap"}</strong><span>{zh ? "点击时段查看汇总" : "Select a cell for details"}</span></div><div className={pageStyles.metricSeg}><button type="button" aria-pressed="true">Token</button><button type="button">{zh ? "预估费用" : "Cost"}</button></div></div><div className={pageStyles.heatmapLabels}>{(zh ? ["一","二","三","四","五","六","日"] : ["M","T","W","T","F","S","S"]).map((label, i) => <span key={`${label}-${i}`}>{label}</span>)}</div><div className={pageStyles.mobileHeatmap}>{Array.from({ length: 42 }, (_, index) => <button key={index} type="button" className={`${pageStyles.heatmapCell} ${pageStyles[`heatLevel${(index * 7 + 3) % 5}`]}`} />)}</div><div className={pageStyles.heatmapLegend}><span>{zh ? "少" : "Low"}</span>{[0,1,2,3,4].map((level) => <i key={level} className={`${pageStyles.heatmapCell} ${pageStyles[`heatLevel${level}`]}`} />)}<span>{zh ? "多" : "High"}</span></div></MobileCardView>
  </MobilePageView>;
}

function ProjectsDemoPage({ zh }: { zh: boolean }) {
  const rows: MobileTaskRowModel[] = zh ? [
    { id: "1", project: "Flowlet", status: "执行中", statusColor: "green", title: "官网发布前检查", round: "第 2 轮", device: "Windows 工作站", updated: "更新于 09:48" },
    { id: "2", project: "Flowlet", status: "待审核", statusColor: "orange", title: "验证移动端同步", round: "第 1 轮", device: "开发主机", updated: "更新于 09:42" },
    { id: "3", project: "Flowlet", status: "已提交", statusColor: "blue", title: "整理 v0.1.0 说明", round: "第 1 轮", device: "Windows 工作站", updated: "更新于 09:30" },
  ] : [
    { id: "1", project: "Flowlet", status: "Running", statusColor: "green", title: "Pre-release website check", round: "Round 2", device: "Windows workstation", updated: "Updated 09:48" },
    { id: "2", project: "Flowlet", status: "Review", statusColor: "orange", title: "Verify mobile sync", round: "Round 1", device: "Dev machine", updated: "Updated 09:42" },
  ];
  return <MobilePageView><MobilePageHeaderView picker title={zh ? "项目 · Flowlet" : "Project · Flowlet"} meta={<small className={styles.lastRefresh}>{zh ? "刚刚刷新" : "Just refreshed"}</small>} subtitle={zh ? "查看所有设备上单个项目的任务，并提交新任务到指定设备" : "Review tasks across devices and submit new work"} /><MobileTaskBoardView tabs={[{ id: "pending", label: zh ? "待处理" : "Pending", count: 3 },{ id: "running", label: zh ? "进行中" : "Running", count: 1 },{ id: "review", label: zh ? "待审核" : "Review", count: 1 },{ id: "done", label: zh ? "已完成" : "Done", count: 8 }]} activeTab="pending" rows={rows} /><button type="button" className={pageStyles.addTaskFab}>+</button></MobilePageView>;
}

function DevicesDemoPage({ zh }: { zh: boolean }) {
  const [expandedId, setExpandedId] = useState<string | null>("desktop-1");
  const entryDetails = <div className={pageStyles.deviceDetails}><div className={pageStyles.deviceDetailsHeader}><strong>{zh ? "设备入口" : "Device entries"}</strong></div><EntryCard icon={<IconComment />} title={zh ? "会话" : "Sessions"} detail={zh ? "12 个会话，2.54亿 Tokens" : "12 sessions · 254M tokens"} meta={zh ? "1 个运行中 · 1 个等待确认" : "1 running · 1 waiting"} /><EntryCard icon={<IconDesktop />} title="Agent" detail={zh ? "4 个已安装 Agent" : "4 installed agents"} meta={zh ? "4 个已接入 Flowlet" : "4 connected to Flowlet"} /></div>;
  const rows: MobileDeviceRowModel[] = [{ id: "desktop-1", name: zh ? "Windows 工作站" : "Windows workstation", platform: "Windows", appVersion: "0.1.0", status: zh ? "直连 18ms" : "Direct · 18ms", statusTone: "ok", metrics: ["2.54亿 Tokens", zh ? "1,855 次请求" : "1,855 requests"], lastSeen: zh ? "最近快照：刚刚" : "Latest snapshot: just now", details: entryDetails },{ id: "desktop-2", name: zh ? "开发主机" : "Development machine", platform: "Windows", appVersion: "0.1.0", status: zh ? "仅云端" : "Cloud only", statusTone: "muted", metrics: ["6.28M Tokens", zh ? "428 次请求" : "428 requests"], lastSeen: zh ? "最近快照：2 分钟前" : "Latest snapshot: 2 min ago" }];
  return <MobilePageView><MobilePageHeaderView picker title={zh ? "设备" : "Devices"} meta={<small className={styles.lastRefresh}>{zh ? "刚刚刷新" : "Just refreshed"}</small>} subtitle={zh ? "查看同步设备、已安装 Agent 及其 Flowlet 接入状态" : "Inspect synced devices, agents, and Flowlet status"} /><MobileDeviceListView rows={rows} expandedId={expandedId} onToggle={(id) => setExpandedId((current) => current === id ? null : id)} /></MobilePageView>;
}

function EntryCard({ icon, title, detail, meta }: { icon: ReactNode; title: string; detail: string; meta: string }) { return <button type="button" className={pageStyles.entryCard}><span className={pageStyles.entryIcon}>{icon}</span><span className={pageStyles.entryMain}><strong>{title}</strong><span>{detail}</span><small>{meta}</small></span><IconChevronRight className={pageStyles.entryChevron} /></button>; }

function SettingsDemoPage({ zh }: { zh: boolean }) {
  return <MobilePageView><MobilePageHeaderView title={zh ? "设置" : "Settings"} subtitle={zh ? "管理外观、连接方式和应用信息" : "Manage appearance, connections, and app information"} />
    <MobileCardView><div className={pageStyles.cardHeader}><div><strong>{zh ? "快速连接" : "Quick connect"}</strong><span>{zh ? "扫描桌面端二维码，或粘贴完整连接文本" : "Scan a desktop QR code or paste the connection package"}</span></div></div><div className={pageStyles.actions}><Button theme="solid" type="primary">{zh ? "扫描二维码" : "Scan QR code"}</Button><Button>{zh ? "粘贴连接文本" : "Paste connection"}</Button></div></MobileCardView>
    <MobileCardView><div className={pageStyles.cardHeader}><div><strong>{zh ? "同步状态" : "Sync status"}</strong><span>{zh ? "从云端刷新设备、用量和会话摘要" : "Refresh device, usage, and session summaries"}</span></div><Button theme="borderless" icon={<IconRefresh />}>{zh ? "刷新" : "Refresh"}</Button></div><div className={pageStyles.syncStrip}><div className={pageStyles.status} data-state="success"><i /><span>{zh ? "远端数据已是最新" : "Remote data is current"}</span></div><time>09:58</time></div></MobileCardView>
    <MobileCardView><div className={pageStyles.cardHeader}><div><strong>{zh ? "外观" : "Appearance"}</strong><span>{zh ? "语言、主题和 Token 展示单位修改后立即生效" : "Language, theme, and token units update immediately"}</span></div></div><div className={pageStyles.preferenceRows}><label><span>{zh ? "显示语言" : "Language"}</span><Select value={zh ? "zh" : "en"} optionList={[{value:"zh",label:"简体中文"},{value:"en",label:"English"}]} /></label><label><span>{zh ? "界面主题" : "Theme"}</span><Select value="system" optionList={[{value:"system",label:zh ? "跟随系统" : "System"}]} /></label><label><span>{zh ? "Token 展示单位" : "Token units"}</span><Select value="auto" optionList={[{value:"auto",label:zh ? "跟随语言" : "Automatic"}]} /></label></div></MobileCardView>
  </MobilePageView>;
}
