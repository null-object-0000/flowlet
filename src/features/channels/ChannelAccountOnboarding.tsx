import React from "react";
import { Button, Group, SimpleGrid, Text } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { Panel, PanelHeader } from "../../components/ui";

type ChannelAccountOnboardingProps = {
  onCreateAccount: (channelId: string) => void;
};

function AccountEmptyIllustration() {
  return (
    <div className="overview-empty-illustration" aria-hidden="true">
      <span className="empty-dot dot-a" />
      <span className="empty-dot dot-b" />
      <span className="empty-dot dot-c" />
      <div className="empty-base" />
      <div className="empty-avatar">
        <IconRobot size={34} stroke={1.8} />
      </div>
    </div>
  );
}

export function ChannelAccountOnboarding({ onCreateAccount }: ChannelAccountOnboardingProps) {
  return (
    <Panel className="overview-onboarding-card">
      <PanelHeader>
        <h3>渠道账号</h3>
      </PanelHeader>
      <div className="overview-empty-state">
        <AccountEmptyIllustration />
        <Text className="overview-empty-title">
          你还没有添加任何渠道账号，先添加 LongCat 或 DeepSeek 账号后，
          才能开放模型并接入客户端与 AI Agent。
        </Text>
        <Group justify="center" gap="md">
          <Button size="sm" className="longcat-action" onClick={() => onCreateAccount("longcat")}>添加 LongCat 账号</Button>
          <Button size="sm" onClick={() => onCreateAccount("deepseek")}>添加 DeepSeek 账号</Button>
        </Group>
        <div className="overview-steps">
          <span />
          <strong>接入流程（仅需 3 步）</strong>
          <span />
        </div>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" className="overview-step-grid">
          <div><b>1</b><strong>添加渠道账号</strong><span>选择 LongCat 或 DeepSeek</span></div>
          <div><b>2</b><strong>开放模型</strong><span>选择并开放模型给代理</span></div>
          <div><b>3</b><strong>接入客户端 / AI Agent</strong><span>获取访问地址并开始使用</span></div>
        </SimpleGrid>
      </div>
    </Panel>
  );
}
