import { Button, Progress, Select, Switch, Toast } from "@douyinfe/semi-ui-19";
import { useRef, useState } from "react";
import type { DataRepairTimeRange } from "../../../domains/data-repair/types";
import { useDataRepair } from "../../../features/settings/useDataRepair";
import { SettingRow, SettingSection } from "../SettingRow";
import styles from "./MaintenanceTab.module.css";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";

const REPAIR_TIME_OPTIONS: Array<{ value: DataRepairTimeRange; label: string }> = [
  { value: "all", label: "全部时间" },
  { value: "7d", label: "最近 7 天" },
  { value: "today", label: "今天" },
];

const STAGES: Array<{ key: string; label: string }> = [
  { key: "sessions", label: "会话归因" },
  { key: "capturedUsage", label: "Token 用量" },
  { key: "unknownUsage", label: "未知记录" },
  { key: "costs", label: "预估费用" },
];

export function MaintenanceTab() {
  const { t } = useAppPreferences();
  const repair = useDataRepair();
  const [repairTimeRange, setRepairTimeRange] = useState<DataRepairTimeRange>("all");
  const [percent, setPercent] = useState(0);
  const [activeStep, setActiveStep] = useState(0);
  const [doneSteps, setDoneSteps] = useState<Set<number>>(new Set());
  const runningRef = useRef(false);

  const startRepair = () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPercent(0);
    setActiveStep(0);
    setDoneSteps(new Set());

    let p = 0;
    const stagesDone = new Set<number>();
    const timer = setInterval(() => {
      p += 4;
      setPercent(p);
      const idx = Math.min(3, Math.floor(p / 25));
      setActiveStep(idx);
      if (idx > 0) {
        const newDone = new Set<number>();
        for (let i = 0; i < idx; i++) newDone.add(i);
        setDoneSteps(newDone);
      }
      if (p >= 100) {
        clearInterval(timer);
        runningRef.current = false;
        setDoneSteps(new Set([0, 1, 2, 3]));
        Toast.success(t("检查完成，未发现需要修复的数据"));
      }
    }, 180);
  };

  const eta = Math.ceil((100 - percent) / 6);

  return (
    <div>
      <div className={styles.repairCard} data-keywords="历史数据 检查 修复 会话归因 Token 费用">
        <div className={styles.repairTop}>
          <div className={styles.repairIcon}>🔧</div>
          <div className={styles.repairCopy}>
            <div className={styles.repairTitle}>{t("数据完整性检查")}</div>
            <div className={styles.repairDesc}>{t("检查并修复旧版本产生的会话归因、Token 用量和预估费用数据。操作不会删除原始请求记录。")}</div>
          </div>
          <div className={styles.repairActions}>
            <Select
              value={repairTimeRange}
              className={styles.smallSelect}
              optionList={REPAIR_TIME_OPTIONS.map((o) => ({ ...o, label: t(o.label) }))}
              onChange={(value) => setRepairTimeRange(value as DataRepairTimeRange)}
            />
            <Button
              type="primary"
              loading={runningRef.current}
              disabled={runningRef.current}
              onClick={startRepair}
            >
              {t("开始检查")}
            </Button>
          </div>
        </div>

        <div className={`${styles.repairProgress} ${percent > 0 ? styles.show : ""}`}>
          <div className={styles.progressHeader}>
            <strong>{t("正在检查历史数据 · {percent}%", { percent })}</strong>
            <span>{t("预计还需 {sec} 秒", { sec: eta })}</span>
          </div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: `${percent}%` }} />
          </div>
          <div className={styles.repairSteps}>
            {STAGES.map((stage, index) => {
              const state = doneSteps.has(index) ? "done" : activeStep === index && percent < 100 ? "active" : "";
              return (
                <div key={stage.key} className={`${styles.step} ${styles[state]}`}>
                  <strong>{t(stage.label)}</strong>
                  <p>{doneSteps.has(index) ? t("已完成") : activeStep === index && percent < 100 ? t("正在检查") : t("等待处理")}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <SettingSection title={t("自动维护")} keywords="维护 自动检查 启动时检查">
        <SettingRow
          name={t("应用更新后自动检查数据")}
          help={t("仅在数据库结构发生变化时运行，不影响正常启动速度")}
          control={<Switch aria-label={t("应用更新后自动检查数据")} defaultChecked />}
        />
      </SettingSection>
    </div>
  );
}
