import { Card, Space, Tag, Typography } from "@douyinfe/semi-ui-19";
import styles from "./RewritePlaceholderPage.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Paragraph, Title } = Typography;

export function RewritePlaceholderPage({ title, description }: { title: string; description: string }) {
  const { t } = useAppPreferences();
  return (
    <main className={styles.placeholder}>
      <Card>
        <Space vertical align="start" spacing="medium">
          <Tag color="blue">{t("迁移中")}</Tag>
          <Title heading={3}>{title}</Title>
          <Paragraph>{description}</Paragraph>
        </Space>
      </Card>
    </main>
  );
}
