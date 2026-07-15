import { useNavigate } from "react-router-dom";
import { Button, Card, Space, Typography } from "@douyinfe/semi-ui-19";
import { IconPlus } from "@douyinfe/semi-icons";
import { ProxyStatusCard } from "../../features/proxy-lifecycle/ProxyStatusCard";
import styles from "./OverviewPage.module.css";

const { Paragraph, Text, Title } = Typography;

/**
 * Next OverviewPage — status summary + onboarding. Per AGENTS.md §7:
 *   - Never shows today's requests / tokens / cost / trends / recent logs.
 *   - Never shows API keys here (only inside the account editor).
 *   - Until channels/accounts migrate, we render the proxy status card plus
 *     the "no accounts" three-step onboarding guidance. Sections for exposed
 *     models, client access and Agent access are gated behind the (future)
 *     accounts domain and are intentionally NOT rendered yet.
 */
export function OverviewPage() {
  const navigate = useNavigate();
  // TODO: replace with the real accounts-domain query once migrated.
  const hasAccounts = false;

  return (
    <main className={styles.page}>
      <ProxyStatusCard ready={true} />

      <Card>
        <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
          <Title heading={4} style={{ margin: 0 }}>
            开始接入
          </Title>
          <Paragraph type="tertiary" style={{ margin: 0 }}>
            Flowlet 会在本地启动一个代理，把你的渠道账号安全地提供给 AI 客户端和 Agent 使用。
          </Paragraph>

          <div className={styles.steps}>
            <Step n={1} title="添加渠道账号">
              选择 LongCat 或 DeepSeek，填写 API Key 并测试连接。API Key 仅保存在本地配置中。
            </Step>
            <Step n={2} title="开放模型">
              选择要对外开放的模型。默认开放模型会随账号自动同步。
            </Step>
            <Step n={3} title="接入 AI 客户端">
              在 Claude Code、Cursor、Continue 等工具中填入本地 Base URL 和客户端 Token 即可使用。
            </Step>
          </div>

          <Space>
            <Button type="primary" icon={<IconPlus />} onClick={() => navigate("/channels")}>
              添加 LongCat
            </Button>
            <Button onClick={() => navigate("/channels")}>添加 DeepSeek</Button>
            <Button type="tertiary" onClick={() => navigate("/channels")}>
              管理渠道账号
            </Button>
          </Space>
        </Space>
      </Card>

      {/* Exposed models / Client access / Agent access are intentionally
          hidden until the accounts domain is migrated (AGENTS.md §7). */}
      {hasAccounts && null}
    </main>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className={styles.step}>
      <span className={styles.stepNumber}>{n}</span>
      <Space vertical align="start" spacing="loose">
        <Text strong>{title}</Text>
        <Text type="tertiary" size="small">
          {children}
        </Text>
      </Space>
    </div>
  );
}
