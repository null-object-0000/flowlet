import { Layout, Tag, Typography } from "@douyinfe/semi-ui-19";
import { Outlet } from "react-router-dom";

const { Header, Sider, Content } = Layout;
const { Text, Title } = Typography;

export function AppShell() {
  return (
    <Layout className="next-app-shell">
      <Sider className="next-app-sidebar">
        <div className="next-app-brand">
          <Title heading={5}>Flowlet</Title>
          <Tag color="blue" size="small">Next</Tag>
        </div>
        <Text type="tertiary">新前端导航将在业务迁移阶段加入。</Text>
      </Sider>

      <Layout>
        <Header className="next-app-header">
          <Text strong>Flowlet 前端重构</Text>
        </Header>
        <Content className="next-app-content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}