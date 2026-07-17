import { Button, Modal, Progress, Select, Switch, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconDesktop, IconGlobe, IconHistory, IconMoon, IconSave, IconSun } from "@douyinfe/semi-icons";
import { useState, type ReactNode } from "react";
import { useAppPreferences, type ThemePreference } from "../../app/preferences/AppPreferences";
import type { AppLanguage } from "../../app/preferences/translations";
import type { DataRepairTimeRange } from "../../domains/data-repair/types";
import { useAutostartSetting } from "../../features/settings/useAutostartSetting";
import { useDataImport, useDataExport } from "../../features/settings/useDataImportExport";
import { useDataRepair } from "../../features/settings/useDataRepair";
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
  const repair = useDataRepair();
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
        <Paragraph type="tertiary" style={{ margin: 0 }}>{t("管理 Flowlet 的显示语言、外观、系统行为和本地数据修复")}</Paragraph>
      </header>

      <div className={styles.content}>
        <SettingSection title={t("显示语言")} description={t("选择界面显示语言，修改后立即生效")} icon={<IconGlobe />}>
          <div className={styles.optionGrid}>
            <ChoiceCard selected={language === "zh-CN"} title={t("简体中文")} description={t("中文界面")} onClick={() => setLanguage("zh-CN")} />
            <ChoiceCard selected={language === "en-US"} title="English" description={t("英文界面")} onClick={() => setLanguage("en-US")} />
          </div>
        </SettingSection>

        <SettingSection title={t("界面外观")} description={t("选择系统、浅色或深色主题")} icon={<IconSun />}>
          <div className={styles.themeGrid}>
            <ThemeCard value="system" current={theme} icon={<IconDesktop />} title={t("跟随系统")} description={t("根据操作系统的外观设置自动切换")} onChange={setTheme} />
            <ThemeCard value="light" current={theme} icon={<IconSun />} title={t("浅色模式")} description={t("始终使用浅色外观")} onChange={setTheme} />
            <ThemeCard value="dark" current={theme} icon={<IconMoon />} title={t("深色模式")} description={t("始终使用深色外观")} onChange={setTheme} />
          </div>
        </SettingSection>

        <SettingSection title={t("系统")} description={t("配置 Flowlet 的系统启动行为")} icon={<IconDesktop />}>
          <div className={styles.switchRow}>
            <span>
              <strong>{t("开机启动")}</strong>
              <small>{t("登录系统后在后台启动 Flowlet，代理服务会继续按应用规则自动启动")}</small>
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
        </SettingSection>

        <SettingSection title={t("本地数据修复")} description={t("修补会话归因、用量与成本数据")} icon={<IconHistory />}>
          <div className={styles.repairPanel}>
            <div className={styles.repairIntro}>
              <span>
                <strong>{t("检查并修复历史请求数据")}</strong>
                <small>{t("依次修复 Claude Code、OpenCode 会话归因、Token 用量、未知记录和预估费用。仅能恢复已捕获请求头或响应体的数据。")}</small>
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
                <Button loading={repair.state.status === "running"} disabled={repair.state.status === "running"} onClick={() => void runDataRepair()}>
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
        </SettingSection>

        <SettingSection title={t("数据管理")} description={t("将全部数据（配置、账号、模型、请求日志等）导出为备份文件，或从备份文件恢复")} icon={<IconSave />}>
          <div className={exportProgress ? styles.dataPanelExporting : styles.dataPanel}>
            <span>
              <strong>{t("导出和导入全部数据")}</strong>
              <small>{t("导出：将当前所有数据保存为备份文件。导入：从备份文件恢复，覆盖当前数据并自动重启代理。")}</small>
            </span>
            <div className={styles.dataButtons}>
              <Button loading={exportPending} disabled={dataImport.isPending} onClick={() => void handleExport()}>
                {exportProgress ? exportProgress.message : t("导出数据")}
              </Button>
              <Button loading={dataImport.isPending} disabled={exportPending} type="danger" onClick={() => void handleImport()}>
                {t("导入数据")}
              </Button>
            </div>
            {exportProgress && exportProgress.stage !== "done" ? (
              <Progress percent={stagePercent(exportProgress.stage)} size="small" showInfo className={styles.dataProgress} />
            ) : null}
          </div>
        </SettingSection>
      </div>
    </main>
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

function ChoiceCard({ selected, title, description, onClick }: { selected: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" aria-pressed={selected} className={`${styles.choice} ${selected ? styles.selected : ""}`} onClick={onClick}><span><strong>{title}</strong><small>{description}</small></span></button>;
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

function ThemeCard({ value, current, icon, title, description, onChange }: { value: ThemePreference; current: ThemePreference; icon: ReactNode; title: string; description: string; onChange: (value: ThemePreference) => void }) {
  const selected = value === current;
  return <button type="button" aria-pressed={selected} className={`${styles.themeChoice} ${selected ? styles.selected : ""}`} onClick={() => onChange(value)}><i>{icon}</i><span><strong>{title}</strong><small>{description}</small></span></button>;
}

function stagePercent(stage: string): number {
  switch (stage) {
    case "reading_config": return 5;
    case "backing_up_db": return 20;
    case "compressing": return 50;
    case "done": return 100;
    default: return 0;
  }
}

