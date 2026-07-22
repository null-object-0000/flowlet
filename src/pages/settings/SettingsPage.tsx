import { Button, InputNumber, Modal, Progress, Select, Switch, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconDesktop, IconDownload, IconFolder, IconGlobe, IconSun, IconUpload } from "@douyinfe/semi-icons";
import { useState, type ReactNode } from "react";
import { useAppPreferences, type ThemePreference } from "../../app/preferences/AppPreferences";
import type { AppLanguage } from "../../app/preferences/translations";
import type { DataRepairTimeRange } from "../../domains/data-repair/types";
import { useAutostartSetting } from "../../features/settings/useAutostartSetting";
import { useDataImport, useDataExport } from "../../features/settings/useDataImportExport";
import { useDataRepair } from "../../features/settings/useDataRepair";
import { useLogCaptureSetting } from "../../features/settings/useLogCaptureSetting";
import { useStorageUsage } from "../../features/settings/useStorageUsage";
import styles from "./SettingsPageStatic.module.css";

const { Paragraph, Title } = Typography;
const REPAIR_TIME_OPTIONS: Array<{ value: DataRepairTimeRange; label: string }> = [
  { value: "1h", label: "最近 1 小时" },
  { value: "6h", label: "最近 6 小时" },
  { value: "today", label: "今天" },
  { value: "7d", label: "最近 7 天" },
  { value: "all", label: "全部时间" },
];

export function SettingsPage() {
  const { language, setLanguage, theme, setTheme, t } = useAppPreferences();
  const autostart = useAutostartSetting();
  const logCapture = useLogCaptureSetting();
  const repair = useDataRepair();
  const storageUsage = useStorageUsage();
  const { mutateAsync: exportAsync, isPending: exportPending, progress: exportProgress } = useDataExport();
  const dataImport = useDataImport();
  const [repairTimeRange, setRepairTimeRange] = useState<DataRepairTimeRange>("all");

  async function runDataRepair() {
    try {
      await repair.run(repairTimeRange);
      Toast.success(t("本地数据修复完成"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Toast.error(t("本地数据修复失败：{message}", { message }));
    }
  }

  async function updateLogCapture<K extends keyof LogCaptureConfigState>(key: K, value: LogCaptureConfigState[K]) {
    if (!logCapture.query.data) return;
    const updated = { ...logCapture.query.data, [key]: value };
    try {
      await logCapture.mutation.mutateAsync(updated);
      Toast.success(t("日志捕获设置已保存"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Toast.error(t("保存失败：{message}", { message }));
    }
  }

  async function updateAutostart(checked: boolean) {
    try {
      const enabled = await autostart.mutation.mutateAsync(checked);
      Toast.success(t(enabled ? "开机启动已启用" : "开机启动已关闭"));
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      Toast.error(t("更新开机启动失败：{message}", { message }));
    }
  }

  async function handleExport() {
    try {
      await exportAsync();
      Toast.success(t("数据导出成功"));
    } catch (error) {
      if (error instanceof Error && error.message === "CANCELLED") return;
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      Toast.error(t("数据导出失败：{message}", { message }));
    }
  }

  async function handleImport() {
    Modal.confirm({
      title: t("确认导入数据"),
      content: t("导入将覆盖当前全部数据（配置、账号、模型、请求日志等），此操作不可撤销。确定继续？"),
      okText: t("确认导入"),
      cancelText: t("取消"),
      onOk: async () => {
        try {
          await dataImport.mutateAsync();
          Toast.success(t("数据导入成功，代理已重新启动"));
        } catch (error) {
          if (error instanceof Error && error.message === "CANCELLED") return;
          const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
          Toast.error(t("数据导入失败：{message}", { message }));
        }
      },
    });
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Title heading={3} style={{ margin: 0 }}>{t("应用设置")}</Title>
        <Paragraph type="tertiary" style={{ margin: 0 }}>{t("管理 Flowlet 的应用偏好、系统行为和本地数据")}</Paragraph>
      </header>

      <div className={styles.content}>
        <section className={styles.preferencesCard} aria-label={t("应用偏好")}>
          <PreferenceField title={t("显示语言")} titleId="settings-language-label" icon={<IconGlobe />}>
            <Select
              className={styles.selectControl}
              aria-labelledby="settings-language-label"
              value={language}
              optionList={[
                { value: "zh-CN", label: t("简体中文") },
                { value: "en-US", label: "English" },
              ]}
              onChange={(value) => setLanguage(value as AppLanguage)}
            />
          </PreferenceField>

          <PreferenceField title={t("界面外观")} titleId="settings-theme-label" icon={<IconSun />}>
            <Select
              className={styles.selectControl}
              aria-labelledby="settings-theme-label"
              value={theme}
              optionList={[
                { value: "system", label: t("跟随系统") },
                { value: "light", label: t("浅色模式") },
                { value: "dark", label: t("深色模式") },
              ]}
              onChange={(value) => setTheme(value as ThemePreference)}
            />
          </PreferenceField>

          <PreferenceField title={t("系统启动")} icon={<IconDesktop />}>
            <div className={styles.autostartControl}>
              <span>
                <small>{t("登录系统后自动启动 Flowlet")}</small>
                {autostart.query.isError ? <button type="button" onClick={() => void autostart.query.refetch()}>{t("读取开机启动状态失败")} · {t("重试")}</button> : null}
              </span>
              <Switch
                aria-label={t("开机启动")}
                checked={autostart.query.data ?? false}
                loading={autostart.query.isLoading || autostart.mutation.isPending}
                disabled={autostart.query.isError}
                onChange={(checked) => void updateAutostart(checked)}
              />
            </div>
          </PreferenceField>
        </section>

        <section className={styles.section} aria-label={t("日志捕获设置")}>
          <div className={styles.sectionHeader}><i><IconDesktop /></i><span><strong>{t("日志捕获设置")}</strong><small>{t("控制请求/响应数据的捕获与保留策略")}</small></span></div>
          <div className={styles.logCaptureContent}>
            <div className={styles.logCaptureRow}>
              <span>
                <strong>{t("捕获请求 Body")}</strong>
                <small>{t("记录发送到上游的完整请求内容（可能包含大量 Token）")}</small>
              </span>
              <Switch
                aria-label={t("捕获请求 Body")}
                checked={logCapture.query.data?.capture_req_body ?? true}
                loading={logCapture.query.isLoading || logCapture.mutation.isPending}
                onChange={(checked) => void updateLogCapture("capture_req_body", checked)}
              />
            </div>
            <div className={styles.logCaptureRow}>
              <span>
                <strong>{t("捕获响应 Body")}</strong>
                <small>{t("记录上游返回的完整响应内容（用于 Token 用量修复）")}</small>
              </span>
              <Switch
                aria-label={t("捕获响应 Body")}
                checked={logCapture.query.data?.capture_res_body ?? true}
                loading={logCapture.query.isLoading || logCapture.mutation.isPending}
                onChange={(checked) => void updateLogCapture("capture_res_body", checked)}
              />
            </div>
            <div className={styles.logCaptureRow}>
              <span>
                <strong>{t("Body 保留天数")}</strong>
                <small>{t("超过保留期限且已有完整 Token 统计的 Body 将被自动清除；-1 = 永久保留")}</small>
              </span>
              <InputNumber
                aria-label={t("Body 保留天数")}
                min={-1}
                max={365}
                value={logCapture.query.data?.body_retention_days ?? 3}
                disabled={logCapture.query.isLoading || logCapture.mutation.isPending}
                onChange={(value) => {
                  const num = typeof value === "number" ? value : parseInt(String(value), 10);
                  if (!Number.isNaN(num)) void updateLogCapture("body_retention_days", Math.max(-1, Math.min(365, num)));
                }}
                suffix={t("天")}
                style={{ width: 110 }}
              />
            </div>
            <div className={styles.logCaptureRow}>
              <span>
                <strong>{t("Body 体积上限")}</strong>
                <small>{t("Body 数据总占用超过此值时，自动清理最老的 10%（仅清理已有完整 Token 统计的记录）；0 = 不限制")}</small>
              </span>
              <InputNumber
                aria-label={t("Body 体积上限")}
                min={0}
                max={10240}
                step={16}
                value={logCapture.query.data?.body_max_size_mb ?? 128}
                disabled={logCapture.query.isLoading || logCapture.mutation.isPending}
                onChange={(value) => {
                  const num = typeof value === "number" ? value : parseInt(String(value), 10);
                  if (!Number.isNaN(num)) void updateLogCapture("body_max_size_mb", Math.max(0, Math.min(10240, num)));
                }}
                suffix="MB"
                style={{ width: 110 }}
              />
            </div>
            <div className={styles.logCaptureRow}>
              <span>
                <strong>{t("脱敏敏感 Header")}</strong>
                <small>{t("落库前将 Authorization / X-API-Key / Cookie 替换为 [redacted]")}</small>
              </span>
              <Switch
                aria-label={t("脱敏敏感 Header")}
                checked={logCapture.query.data?.redact_sensitive_headers ?? false}
                loading={logCapture.query.isLoading || logCapture.mutation.isPending}
                onChange={(checked) => void updateLogCapture("redact_sensitive_headers", checked)}
              />
            </div>
          </div>
        </section>

        <SettingSection title={t("数据管理")} description={t("修复、备份或恢复 Flowlet 的本地数据")} icon={<IconFolder />}>
          <div className={styles.managementContent}>
            <StorageUsagePanel query={storageUsage} t={t} />

            <div className={styles.repairPanel}>
              <div className={styles.repairIntro}>
                <span>
                  <strong>{t("检查并修复历史数据")}</strong>
                  <small>{t("根据已捕获的请求与响应，补全会话归因、Token 用量和预估费用。")}</small>
                </span>
                <div className={styles.repairControls}>
                  <span id="repair-time-range-label" className={styles.repairControlLabel}>{t("修复时间范围")}</span>
                  <Select
                    aria-labelledby="repair-time-range-label"
                    value={repairTimeRange}
                    disabled={repair.state.status === "running"}
                    optionList={REPAIR_TIME_OPTIONS.map((option) => ({ ...option, label: t(option.label) }))}
                    onChange={(value) => {
                      setRepairTimeRange(value as DataRepairTimeRange);
                      repair.reset();
                    }}
                  />
                  <Button type="primary" theme="solid" loading={repair.state.status === "running"} disabled={repair.state.status === "running"} onClick={() => void runDataRepair()}>
                    {t(repair.state.status === "success" ? "重新修复" : "开始修复")}
                  </Button>
                </div>
              </div>
              {repair.state.status !== "idle" ? <Progress aria-label={t("数据修复进度")} percent={repair.state.percent} size="small" showInfo /> : null}
              <div className={styles.repairStages}>
                <RepairStage label={t("会话归因")} detail={sessionRepairDetail(repair.state.results.sessions, t)} status={stageStatus(repair.state, "sessions")} />
                <RepairStage label={t("Token 用量")} detail={countDetail(repair.state.results.capturedUsage, t("从响应中恢复 {count} 条"), t)} status={stageStatus(repair.state, "capturedUsage")} />
                <RepairStage label={t("未知记录")} detail={countDetail(repair.state.results.unknownUsage, t("补齐 {count} 条"), t)} status={stageStatus(repair.state, "unknownUsage")} />
                <RepairStage label={t("预估费用")} detail={countDetail(repair.state.results.costs, t("重算 {count} 条"), t)} status={stageStatus(repair.state, "costs")} />
              </div>
              {repair.state.error ? <p className={styles.repairError}>{t("修复中断：{message}", { message: repair.state.error })}</p> : null}
            </div>

            <div className={exportProgress ? styles.dataPanelExporting : styles.dataPanel}>
              <span>
                <strong>{t("备份与恢复")}</strong>
                <small>{t("导入备份会覆盖现有数据，并自动重启代理。")}</small>
              </span>
              <div className={styles.dataButtons}>
                <Button aria-label={t("导出数据")} icon={<IconUpload />} loading={exportPending} disabled={dataImport.isPending} onClick={() => void handleExport()}>
                  {exportProgress ? exportProgress.message : t("导出数据")}
                </Button>
                <Button aria-label={t("导入数据")} icon={<IconDownload />} loading={dataImport.isPending} disabled={exportPending} type="primary" theme="solid" onClick={() => void handleImport()}>
                  {t("导入数据")}
                </Button>
              </div>
              {exportProgress && exportProgress.stage !== "done" ? (
                <Progress percent={stagePercent(exportProgress.stage)} size="small" showInfo className={styles.dataProgress} />
              ) : null}
            </div>
          </div>
        </SettingSection>
      </div>
    </main>
  );
}

const STORAGE_CATEGORY_LABELS = {
  configuration: "配置与账号",
  requestLogs: "请求日志",
  bodyData: "请求 Body（过期自动清理）",
  usage: "用量与费用",
  agentSessions: "Agent 会话",
  backgroundTasks: "后台任务",
} as const;

function StorageUsagePanel({ query, t }: { query: ReturnType<typeof useStorageUsage>; t: ReturnType<typeof useAppPreferences>["t"] }) {
  const displayData = query.isCounting ? query.progress : (query.data ?? query.progress);
  const databaseTotal = Math.max(displayData.databaseBytes, 1);
  return (
    <div className={styles.storagePanel}>
      <div className={styles.storageHeader}>
        <span>
          <strong>{t("存储占用")}</strong>
          <small>{t("数据库与配置文件合计")}</small>
        </span>
        <div className={styles.storageTotal}>
          {query.isCounting ? <small><i />{t("正在统计")}</small> : null}
          <b>{formatBytes(displayData.totalBytes)}</b>
        </div>
      </div>

      {query.isError ? (
        <p className={`${styles.storageState} ${styles.storageError}`}>
          {t("读取存储占用失败")}
          <button type="button" onClick={() => void query.refetch()}>{t("重试")}</button>
        </p>
      ) : null}
      {!query.isError ? (
        <>
          <div className={styles.storageGrid}>
            {displayData.categories.map((category) => (
              <div className={`${styles.storageItem} ${query.isCounting ? styles.storageItemCounting : ""}`} key={category.key}>
                <span><i /><small>{t(STORAGE_CATEGORY_LABELS[category.key])}</small></span>
                <strong>{formatBytes(category.allocatedBytes)}</strong>
                <small>{t("{count} 条记录", { count: category.rowCount })}</small>
                <span className={styles.storageMeter} aria-hidden="true">
                  <i style={{ width: `${Math.min(category.allocatedBytes / databaseTotal * 100, 100)}%` }} />
                </span>
              </div>
            ))}
          </div>
          <small className={styles.storageNote}>{t(query.isCounting ? "正在逐页统计，记录数和占用会持续更新。" : "分类占用按数据库页统计；总占用还包含空闲页和临时文件。")}</small>
        </>
      ) : null}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

function PreferenceField({ title, titleId, icon, children }: { title: string; titleId?: string; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={styles.preferenceField}>
      <i>{icon}</i>
      <div className={styles.preferenceBody}>
        <strong id={titleId}>{title}</strong>
        {children}
      </div>
    </div>
  );
}

function SettingSection({ title, description, icon, children }: { title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}><i>{icon}</i><span><strong>{title}</strong><small>{description}</small></span></div>
      {children}
    </section>
  );
}

type RepairStatus = "pending" | "running" | "completed" | "error";

function stageStatus(state: ReturnType<typeof useDataRepair>["state"], stage: import("../../domains/data-repair/types").DataRepairStage): RepairStatus {
  if (state.completedStages.includes(stage)) return "completed";
  if (state.status === "error" && state.currentStage === stage) return "error";
  if (state.currentStage === stage) return "running";
  return "pending";
}

function RepairStage({ label, detail, status }: { label: string; detail: string; status: RepairStatus }) {
  return <div className={`${styles.repairStage} ${styles[status]}`}><i /><span><strong>{label}</strong><small>{detail}</small></span></div>;
}

function sessionRepairDetail(result: ReturnType<typeof useDataRepair>["state"]["results"]["sessions"], t: ReturnType<typeof useAppPreferences>["t"]) {
  return result ? t("修复 {requests} 个请求（{logs} 条日志）", { requests: result.repairedRequests, logs: result.repairedLogs }) : t("等待检查历史请求头");
}

function countDetail(count: number | undefined, template: string, t: ReturnType<typeof useAppPreferences>["t"]) {
  return count == null ? t("等待处理") : template.replace("{count}", String(count));
}

type LogCaptureConfigState = NonNullable<ReturnType<typeof useLogCaptureSetting>["query"]["data"]>;

function stagePercent(stage: string): number {
  switch (stage) {
    case "reading_config": return 5;
    case "backing_up_db": return 20;
    case "compressing": return 50;
    case "done": return 100;
    default: return 0;
  }
}

