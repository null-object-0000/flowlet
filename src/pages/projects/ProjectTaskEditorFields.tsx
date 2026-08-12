import { useState } from "react";
import { Button, Input, Select, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { IconAIEditLevel1 } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import {
  MIN_TITLE_GENERATION_DESCRIPTION_LENGTH,
  canAutoGenerateTaskTitle,
  generateTaskTitle,
} from "../../domains/project/generateTaskTitle";
import type { ProjectTaskType } from "../../domains/project/types";
import { proxyCommands } from "../../domains/proxy/commands";
import { useProxyBindConfig } from "../../features/proxy-lifecycle/useProxyBindConfig";
import { errorMessage } from "../../shared/errors/AppError";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import styles from "./ProjectsPage.module.css";

const TASK_TYPES: Array<{ value: ProjectTaskType; label: string }> = [
  { value: "code", label: "代码修改" },
  { value: "readonly", label: "只读分析" },
];

const AGENT_PROFILES = ["Claude Code", "OpenCode", "Pi", "Codex"];

export interface ProjectTaskEditorValue {
  title: string;
  description: string;
  taskType: ProjectTaskType;
  agentProfile: string;
}

interface ProjectTaskEditorFieldsProps {
  value: ProjectTaskEditorValue;
  onChange: (patch: Partial<ProjectTaskEditorValue>) => void;
  descriptionOptional?: boolean;
}

export function ProjectTaskEditorFields({
  value,
  onChange,
  descriptionOptional = true,
}: ProjectTaskEditorFieldsProps) {
  const { t } = useAppPreferences();
  const proxyBindConfig = useProxyBindConfig();
  const [generatingTitle, setGeneratingTitle] = useState(false);
  const [titleGenStatus, setTitleGenStatus] = useState<string | null>(null);
  const canGenerate = canAutoGenerateTaskTitle(value.description);

  const autoGenerateTitle = async () => {
    if (!canGenerate) return;
    const port = proxyBindConfig.data?.port ?? 18640;
    const baseUrl = `http://127.0.0.1:${port}`;
    const clientToken = proxyBindConfig.data?.default_client_token;
    setGeneratingTitle(true);
    setTitleGenStatus(t("AI 正在生成标题…"));
    try {
      const status = await proxyCommands.status();
      if (!status.running) {
        Toast.warning(t("本地代理未运行，无法自动生成标题"));
        return;
      }
      const title = await generateTaskTitle(
        { baseUrl, clientToken, description: value.description, taskType: value.taskType },
        (progress) => {
          setTitleGenStatus(t("AI 生成中… 已输出 {tokens} tokens，{seconds} 秒", {
            tokens: progress.tokenEstimate,
            seconds: Math.max(1, Math.round(progress.elapsedMs / 1000)),
          }));
        },
      );
      onChange({ title });
      Toast.success(t("标题已生成"));
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setGeneratingTitle(false);
      setTitleGenStatus(null);
    }
  };

  return <>
    <label>
      <span className={styles.titleFieldLabel}>
        {t("任务标题")}
        {generatingTitle && titleGenStatus ? <small className={styles.titleGenStatus}>{titleGenStatus}</small> : null}
      </span>
      <div className={styles.titleInputRow}>
        <Input autoFocus composition value={value.title} maxLength={120} onChange={(title) => onChange({ title })} />
        <Button
          icon={<IconAIEditLevel1 />}
          aria-label={t("自动生成标题")}
          title={canGenerate ? t("根据任务描述自动生成标题") : t("任务描述至少 {n} 字后可自动生成", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })}
          loading={generatingTitle}
          disabled={!canGenerate}
          onClick={() => void autoGenerateTitle()}
        />
      </div>
      {!canGenerate ? <small className={styles.titleGenerateHint}>{t("任务描述至少 {n} 字后可自动生成标题", { n: MIN_TITLE_GENERATION_DESCRIPTION_LENGTH })}</small> : null}
    </label>
    <label>
      <span>{descriptionOptional ? t("任务描述（可选）") : t("任务描述")}</span>
      <TextArea composition value={value.description} autosize={{ minRows: 9, maxRows: 12 }} onChange={(description) => onChange({ description })} />
    </label>
    <div className={styles.formGrid}>
      <label>
        <span>{t("任务类型")}</span>
        <Select value={value.taskType} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={TASK_TYPES.map((item) => ({ value: item.value, label: t(item.label) }))} onChange={(taskType) => onChange({ taskType: String(taskType) as ProjectTaskType })} />
      </label>
      <label>
        <span>{t("Agent Profile")}</span>
        <Select value={value.agentProfile} style={{ width: "100%" }} zIndex={APP_OVERLAY_Z_INDEX.modal} optionList={AGENT_PROFILES.map((agentProfile) => ({ value: agentProfile, label: agentProfile }))} onChange={(agentProfile) => onChange({ agentProfile: String(agentProfile) })} />
      </label>
    </div>
  </>;
}
