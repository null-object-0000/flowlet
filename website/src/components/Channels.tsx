import { Table, Typography } from "@douyinfe/semi-ui-19";
import { IconLink } from "@douyinfe/semi-icons";
import { useI18n } from "../i18n/I18nContext";
import { Section } from "./Section";
import styles from "./Channels.module.css";

const channelIcons: Record<string, string> = {
  LongCat: "/icons/lobe/longcat-color.svg",
  DeepSeek: "/icons/lobe/deepseek-color.svg",
  "Kimi / Moonshot": "/icons/lobe/kimi-color.svg",
  "千问 Qwen": "/icons/lobe/qwen-color.svg",
  Qwen: "/icons/lobe/qwen-color.svg",
};

export function Channels() {
  const { t } = useI18n();

  const columns = [
    {
      title: t.channels.table.channel,
      dataIndex: "name",
      render: (name: string) => {
        const icon = channelIcons[name];
        return (
          <span className={styles.channelName}>
            {icon ? (
              <img src={icon} alt="" className={styles.channelIcon} />
            ) : (
              <span className={styles.customIcon}>
                <IconLink />
              </span>
            )}
            {name}
          </span>
        );
      },
    },
    { title: t.channels.table.openai, dataIndex: "openai" },
    { title: t.channels.table.anthropic, dataIndex: "anthropic" },
    { title: t.channels.table.models, dataIndex: "models" },
    { title: t.channels.table.balance, dataIndex: "balance" },
  ];

  const dataSource = t.channels.rows.map((row, i) => ({ ...row, key: i }));

  return (
    <Section id="channels" title={t.channels.title} subtitle={t.channels.subtitle}>
      <Table
        columns={columns}
        dataSource={dataSource}
        pagination={false}
        className={styles.table}
      />
      <Typography.Paragraph type="tertiary" size="small" className={styles.note}>
        {t.channels.note}
      </Typography.Paragraph>
    </Section>
  );
}
