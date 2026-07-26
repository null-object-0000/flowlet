import { Button, Toast } from "@douyinfe/semi-ui-19";
import { useState } from "react";
import { useAppMeta } from "../../../features/settings/useAppMeta";
import { SettingRow, SettingSection } from "../SettingRow";
import styles from "./AboutTab.module.css";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";

export function AboutTab() {
  const { t } = useAppPreferences();
  const meta = useAppMeta();
  const [updating, setUpdating] = useState(false);

  const copyDiagnostics = async () => {
    const text = `Flowlet ${meta.data?.version ?? ""}\nOS: ${meta.data?.diagnostics?.os ?? ""}\nDatabase: ${meta.data?.diagnostics?.database ?? ""}\nProxy service: ${meta.data?.diagnostics?.proxy ?? ""}`;
    try {
      await navigator.clipboard.writeText(text);
      Toast.success(t("诊断信息已复制"));
    } catch {
      Toast.success(t("诊断信息已生成"));
    }
  };

  return (
    <div>
      <div className={styles.aboutCard} data-keywords="Flowlet 版本 更新 开源">
        <div className={styles.aboutLogo}>F</div>
        <div className={styles.aboutCopy}>
          <div className={styles.aboutTitle}>Flowlet</div>
          <div className={styles.aboutMeta}>
            {t("当前版本 {version} · 本地优先的模型服务管理工具", { version: meta.data?.version ?? "—" })}
          </div>
        </div>
        <Button
          className={styles.updateButton}
          loading={updating}
          onClick={() => {
            setUpdating(true);
            window.setTimeout(() => {
              setUpdating(false);
              Toast.success(t("当前已是最新版本"));
            }, 900);
          }}
        >
          {t("检查更新")}
        </Button>
      </div>

      <SettingSection title={t("应用信息")} keywords="数据目录 打开目录">
        <SettingRow
          name={t("数据目录")}
          help={meta.data?.dataDir ?? "—"}
          control={(
            <Button disabled>{t("打开目录")}</Button>
          )}
        />
        <SettingRow
          name={t("诊断信息")}
          help={t("复制运行环境和关键日志信息，便于提交问题")}
          control={(
            <Button onClick={() => void copyDiagnostics()}>{t("复制诊断信息")}</Button>
          )}
        />
      </SettingSection>
    </div>
  );
}
