import { Button, SideSheet, Tabs, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh } from "@douyinfe/semi-icons";
import type { AgentEnvironmentReport } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import styles from "./AgentAccessSideSheet.module.css";

const { Paragraph, Text, Title } = Typography;
type Copy = (value: string, message: string) => Promise<void>;

type Props = {
  visible: boolean;
  environment?: AgentEnvironmentReport;
  loading?: boolean;
  error?: string;
  onRefresh: () => void;
  onClose: () => void;
  onCopy: Copy;
};

export function ChatGptDesktopSideSheet({
  visible,
  environment,
  loading = false,
  error,
  onRefresh,
  onClose,
  onCopy,
}: Props) {
  const { t } = useAppPreferences();
  const installation = environment?.installations.find((item) => item.surface === "desktop");

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={
        <Tabs
          className={`${styles.titleTabs} ${styles.chatGptTitleTabs}`}
          activeKey="desktop"
          tabList={[
            { tab: <span className={styles.titleTabLabel}>{t("ChatGPT (Codex) CLI 接入")}</span>, itemKey: "cli", disabled: true },
            { tab: <span className={styles.titleTabLabel}>{t("ChatGPT (Codex) Desktop 接入")}</span>, itemKey: "desktop" },
          ]}
        />
      }
      headerStyle={{ paddingBottom: 0 }}
      width={680}
      onCancel={onClose}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <section className={styles.intro}>
          <Tag color="blue">Desktop</Tag>
          <Paragraph type="tertiary">
            {t("检测新版 ChatGPT Desktop 的安装版本和位置。")}
          </Paragraph>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("本机环境")}</Title>
              <Text type="tertiary">{t("仅识别统一后的新版 ChatGPT Desktop")}</Text>
            </div>
            <Button icon={<IconRefresh />} loading={loading} onClick={onRefresh}>
              {t("重新检测")}
            </Button>
          </div>

          {error ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("检测失败：{message}", { message: error })}
            </Text>
          ) : !installation ? (
            <Text className={styles.environmentMessage} type="tertiary">
              {loading ? t("正在检测…") : t("未检测到 ChatGPT Desktop")}
            </Text>
          ) : (
            <div className={styles.installation}>
              <div className={styles.installationHeader}>
                <strong>
                  {installation.version
                    ? t("ChatGPT Desktop {version}", { version: installation.version })
                    : t("ChatGPT Desktop 已安装")}
                </strong>
                {!installation.version && <Tag color="green">{t("已安装")}</Tag>}
              </div>
              <ConfigRow label={t("应用路径")} value={installation.executable_path} onCopy={onCopy} />
              <ConfigRow label={t("安装目录")} value={installation.install_dir} onCopy={onCopy} />
            </div>
          )}
        </section>
      </div>
    </SideSheet>
  );
}

function ConfigRow({ label, value, onCopy }: { label: string; value: string; onCopy: Copy }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.configRow}>
      <Text type="tertiary">{label}</Text>
      <code title={value}>{value}</code>
      <Button
        theme="borderless"
        type="primary"
        icon={<IconCopy />}
        aria-label={t("复制 {label}", { label })}
        onClick={() => void onCopy(value, t("{label} 已复制", { label }))}
      />
    </div>
  );
}
