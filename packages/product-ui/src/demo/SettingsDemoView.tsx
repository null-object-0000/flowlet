import { useState } from "react";
import { Button, Select, Switch } from "@douyinfe/semi-ui-19";
import { IconCamera, IconCloud, IconSearch, IconSetting, IconWrench } from "@douyinfe/semi-icons";
import { DemoPageScaffold } from "./DemoPageScaffold";
import styles from "./SettingsDemoView.module.css";

const TABS = ["general", "capture", "sync", "storage", "maintenance", "about"] as const;
type Tab = typeof TABS[number];

export function SettingsDemoView({ zh, appVersion }: { zh: boolean; appVersion: string }) {
  const [tab, setTab] = useState<Tab>("general");
  const [autostart, setAutostart] = useState(true);
  const [notifications, setNotifications] = useState(true);
  const [capture, setCapture] = useState(true);
  const labels: Record<Tab, string> = { general: zh ? "通用" : "General", capture: zh ? "数据捕获" : "Capture", sync: zh ? "同步管理" : "Sync", storage: zh ? "存储空间" : "Storage", maintenance: zh ? "维护" : "Maintenance", about: zh ? "关于" : "About" };
  const descriptions: Record<Tab, string> = { general: zh ? "管理应用启动、主题和通知偏好" : "Startup, theme and notification preferences", capture: zh ? "控制请求和响应数据的本地记录范围" : "Control local request and response capture", sync: zh ? "配置你自己的 S3-compatible 多设备同步" : "Configure your own S3-compatible device sync", storage: zh ? "查看本地数据库与各类数据占用" : "Inspect local database and category usage", maintenance: zh ? "执行完整性检查、备份与清理" : "Run integrity checks, backups and cleanup", about: zh ? "版本、数据目录与诊断信息" : "Version, data directory and diagnostics" };

  return <DemoPageScaffold
    title={zh ? "应用设置" : "Settings"}
    subtitle={zh ? "管理应用偏好、本地数据与安全策略" : "Manage preferences, local data and security"}
    controls={<label className={styles.search}><IconSearch /><input aria-label={zh ? "搜索设置" : "Search settings"} placeholder={zh ? "搜索设置" : "Search settings"} /></label>}
  >
    <div className={styles.shell}>
      <nav className={styles.nav} aria-label={zh ? "设置分类" : "Settings categories"}>
        {TABS.map((key, index) => <button key={key} type="button" aria-label={labels[key]} aria-pressed={tab === key} onClick={() => setTab(key)}>{index === 0 ? <IconSetting /> : index === 1 ? <IconCamera /> : index === 2 ? <IconCloud /> : index === 4 ? <IconWrench /> : <span className={styles.dotIcon} />}<span>{labels[key]}</span></button>)}
      </nav>
      <section className={styles.panel}>
        <header><h2>{labels[tab]}</h2><p>{descriptions[tab]}</p></header>
        <div className={styles.body}>{tab === "general" ? <>
          <SettingsGroup title={zh ? "应用偏好" : "Preferences"}>
            <SettingRow title={zh ? "开机自动启动" : "Launch at startup"} desc={zh ? "登录 Windows 后自动启动 Flowlet，本地代理会按当前配置运行。" : "Start Flowlet after sign-in and run the local proxy."}><Switch checked={autostart} onChange={setAutostart} /></SettingRow>
            <SettingRow title={zh ? "任务审核通知" : "Task review notifications"} desc={zh ? "项目任务进入待审核时发送系统通知。" : "Notify when a project task needs review."}><Switch checked={notifications} onChange={setNotifications} /></SettingRow>
          </SettingsGroup>
          <SettingsGroup title={zh ? "外观与语言" : "Appearance and language"}>
            <SettingRow title={zh ? "界面主题" : "Theme"} desc={zh ? "跟随系统，也可单独选择浅色或深色。" : "Follow the system or choose light or dark."}><Select value="system" optionList={[{ value: "system", label: zh ? "跟随系统" : "System" }]} /></SettingRow>
            <SettingRow title={zh ? "显示语言" : "Language"} desc={zh ? "应用界面使用的语言。" : "Language used by the application."}><Select value={zh ? "zh" : "en"} optionList={[{ value: zh ? "zh" : "en", label: zh ? "简体中文" : "English" }]} /></SettingRow>
          </SettingsGroup>
        </> : tab === "capture" ? <>
          <SettingsGroup title={zh ? "请求日志捕获" : "Request capture"}>
            <SettingRow title={zh ? "记录请求与响应 Body" : "Capture request and response bodies"} desc={zh ? "用于问题排查；关闭后仍记录状态、耗时与用量。" : "Useful for debugging; status, timing and usage remain available."}><Switch checked={capture} onChange={setCapture} /></SettingRow>
            <SettingRow title={zh ? "敏感 Header 脱敏" : "Redact sensitive headers"} desc={zh ? "落库前将 Authorization、API Key 等替换为 [redacted]。" : "Replace authorization and API key values before storage."}><Switch /></SettingRow>
          </SettingsGroup>
        </> : <FeaturePanel tab={tab} zh={zh} appVersion={appVersion} />}</div>
      </section>
    </div>
  </DemoPageScaffold>;
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) { return <section className={styles.group}><h3>{title}</h3><div>{children}</div></section>; }
function SettingRow({ title, desc, children }: { title: string; desc: string; children: React.ReactNode }) { return <div className={styles.row}><span><strong>{title}</strong><small>{desc}</small></span><div>{children}</div></div>; }
function FeaturePanel({ tab, zh, appVersion }: { tab: Tab; zh: boolean; appVersion: string }) {
  const copy: Record<Exclude<Tab, "general" | "capture">, [string, string, string]> = {
    sync: [zh ? "多设备同步" : "Multi-device sync", zh ? "使用你自己的 S3-compatible 存储同步用量、会话和项目数据。" : "Use your own S3-compatible storage for usage, sessions and projects.", zh ? "配置 S3" : "Configure S3"],
    storage: [zh ? "本地数据占用" : "Local storage", zh ? "SQLite 数据库 48.6 MB · 请求日志 31.2 MB · Agent 会话 9.4 MB" : "SQLite 48.6 MB · Requests 31.2 MB · Agent sessions 9.4 MB", zh ? "导出数据" : "Export data"],
    maintenance: [zh ? "数据完整性检查" : "Data integrity", zh ? "检查历史日志归属、会话关联和用量统计完整性。" : "Check historical attribution, session links and usage integrity.", zh ? "开始检查" : "Start check"],
    about: [`Flowlet v${appVersion}`, zh ? "本地模型服务控制台 · Windows 11 原生环境" : "Local model service console · Native Windows 11", zh ? "复制诊断信息" : "Copy diagnostics"],
  };
  const [title, desc, action] = copy[tab as keyof typeof copy];
  return <section className={styles.feature}><span className={styles.featureMark}><IconSetting /></span><h3>{title}</h3><p>{desc}</p><Button type="primary" theme="solid">{action}</Button></section>;
}
