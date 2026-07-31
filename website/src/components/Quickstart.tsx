import { Button, Table, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { Section } from "./Section";
import styles from "./Quickstart.module.css";

const INSTALL_CMDS = `git clone https://github.com/null-object-0000/flowlet.git
cd flowlet
npm ci
npm run tauri:dev`;

export function Quickstart() {
  const { t } = useI18n();

  const endpointColumns = [
    { title: t.quickstart.endpoints.usage, dataIndex: "usage" },
    {
      title: t.quickstart.endpoints.address,
      dataIndex: "address",
      render: (address: string) => <code className={styles.code}>{address}</code>,
    },
  ];

  const endpointData = t.quickstart.endpoints.rows.map((row, i) => ({ ...row, key: i }));

  async function copyInstall() {
    try {
      await navigator.clipboard.writeText(INSTALL_CMDS);
      Toast.success({ content: "Copied", duration: 1.5 });
    } catch {
      Toast.error({ content: "Copy failed", duration: 2 });
    }
  }

  return (
    <Section id="quickstart" title={t.quickstart.title} subtitle={t.quickstart.subtitle}>
      <div className={styles.columns}>
        <div className={styles.left}>
          <div className={styles.terminal}>
            <div className={styles.terminalBar}>
              <span className={styles.terminalTitle}>bash</span>
              <Button
                icon={<IconCopy />}
                size="small"
                theme="borderless"
                type="tertiary"
                onClick={copyInstall}
                aria-label="Copy install commands"
              />
            </div>
            <pre className={styles.pre}>{INSTALL_CMDS}</pre>
          </div>
          <Typography.Paragraph type="secondary" size="small" className={styles.requirements}>
            {t.quickstart.requirements}
          </Typography.Paragraph>
          <Typography.Title heading={4} className={styles.stepsTitle}>
            {t.quickstart.stepsTitle}
          </Typography.Title>
          <ol className={styles.steps}>
            {t.quickstart.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
        </div>
        <div className={styles.right}>
          <Typography.Title heading={4} className={styles.stepsTitle}>
            {t.quickstart.endpointsTitle}
          </Typography.Title>
          <Table
            columns={endpointColumns}
            dataSource={endpointData}
            pagination={false}
            size="small"
            className={styles.table}
          />
          <Typography.Paragraph type="tertiary" size="small" className={styles.endpointNote}>
            {t.quickstart.endpointsNote}
          </Typography.Paragraph>
        </div>
      </div>
    </Section>
  );
}
