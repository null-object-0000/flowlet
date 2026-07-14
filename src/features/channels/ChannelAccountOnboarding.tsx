import React from "react";
import { Button, Group, SimpleGrid, Text } from "@mantine/core";
import { IconRobot } from "@tabler/icons-react";
import { Panel, PanelHeader } from "../../components/ui";
import styles from "./ChannelAccountOnboarding.module.css";

type ChannelAccountOnboardingProps = {
  onCreateAccount: (channelId: string) => void;
};

function AccountEmptyIllustration() {
  return (
    <div className={styles.illustration} aria-hidden="true">
      <span className={styles.dot + " " + styles.dotA} />
      <span className={styles.dot + " " + styles.dotB} />
      <span className={styles.dot + " " + styles.dotC} />
      <div className={styles.base} />
      <div className={styles.avatar}>
        <IconRobot size={34} stroke={1.8} />
      </div>
    </div>
  );
}

export function ChannelAccountOnboarding({ onCreateAccount }: ChannelAccountOnboardingProps) {
  return (
    <Panel className={styles.card}>
      <PanelHeader>
        <h3>渠道账号</h3>
      </PanelHeader>
      <div className={styles.emptyState}>
        <AccountEmptyIllustration />
        <Text className={styles.title}>
          你还没有添加任何渠道账号，先添加 LongCat 或 DeepSeek 账号后，
          才能开放模型并接入客户端与 AI Agent。
        </Text>
        <Group justify="center" gap="md">
          <Button size="sm" className={styles.longcatAction} onClick={() => onCreateAccount("longcat")}>添加 LongCat 账号</Button>
          <Button size="sm" onClick={() => onCreateAccount("deepseek")}>添加 DeepSeek 账号</Button>
        </Group>
        <div className={styles.steps}>
          <span />
          <strong>接入流程（仅需 3 步）</strong>
          <span />
        </div>
        <SimpleGrid cols={{ base: 1, sm: 3 }} spacing="lg" className={styles.stepGrid}>
          <div><b>1</b><strong>添加渠道账号</strong><span>选择 LongCat 或 DeepSeek</span></div>
          <div><b>2</b><strong>开放模型</strong><span>选择并开放模型给代理</span></div>
          <div><b>3</b><strong>接入客户端 / AI Agent</strong><span>获取访问地址并开始使用</span></div>
        </SimpleGrid>
      </div>
    </Panel>
  );
}
