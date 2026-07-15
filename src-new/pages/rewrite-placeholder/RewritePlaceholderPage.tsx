import { Card, Space, Tag, Typography } from "@douyinfe/semi-ui-19";
import styles from "./RewritePlaceholderPage.module.css";

const { Paragraph, Title } = Typography;

export function RewritePlaceholderPage() {
  return (
    <main className={styles.placeholder}>
      <Card>
        <Space vertical align="start" spacing="medium">
          <Tag color="green">架构基座</Tag>
          <Title heading={3}>新前端已独立运行</Title>
          <Paragraph>
            当前只包含 Provider、Router、应用壳和 Tauri 调用边界，不包含任何业务页面。
          </Paragraph>
        </Space>
      </Card>
    </main>
  );
}