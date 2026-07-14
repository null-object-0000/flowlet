import React from "react";
import { ActionIcon, Box, Code, Drawer, Group, Stack, Text } from "@mantine/core";
import { IconCopy } from "@tabler/icons-react";
import { ProxyBindConfig, ProxyStatus } from "../../domain";

type ApiAccessDrawerProps = {
  opened: boolean;
  onClose: () => void;
  baseUrl: string;
  bindConfig: ProxyBindConfig;
  running: boolean;
  onCopy: (text: string, done: string) => Promise<void>;
};

export function ApiAccessDrawer({ opened, onClose, baseUrl, bindConfig, running, onCopy }: ApiAccessDrawerProps) {
  const host = bindConfig.host || "127.0.0.1";

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      title="API 接入详情"
      position="right"
      size="min(720px, 92vw)"
      padding="md"
    >
      <Box className="api-detail-drawer">
        <section className="api-detail-section">
          <h4><span className="mini-section-icon">▣</span>服务信息</h4>
          <div className="api-detail-row">
            <span className="api-detail-label">服务基础地址</span>
            <Code className="api-detail-value">{baseUrl}</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制服务基础地址" onClick={() => void onCopy(baseUrl, "服务基础地址已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">监听地址</span>
            <Code className="api-detail-value">{running ? host : "-"}</Code>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">当前端口</span>
            <Code className="api-detail-value">{String(bindConfig.port)}</Code>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">健康检查地址</span>
            <Code className="api-detail-value">/health</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制健康检查地址" onClick={() => void onCopy(`${baseUrl}/health`, "健康检查地址已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
        </section>

        <section className="api-detail-section">
          <h4><span className="mini-section-icon">▤</span>OpenAI-compatible</h4>
          <div className="api-detail-row">
            <span className="api-detail-label">Base URL</span>
            <Code className="api-detail-value">{baseUrl}/v1</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制 OpenAI Base URL" onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">模型列表</span>
            <Code className="api-detail-value">GET /v1/models</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制模型列表地址" onClick={() => void onCopy(`${baseUrl}/v1/models`, "模型列表地址已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">对话接口</span>
            <Code className="api-detail-value">POST /v1/chat/completions</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制对话接口地址" onClick={() => void onCopy(`${baseUrl}/v1/chat/completions`, "对话接口地址已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">鉴权 Header</span>
            <Code className="api-detail-value">Authorization: Bearer &lt;Client Token&gt;</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制鉴权 Header" onClick={() => void onCopy("Authorization: Bearer <Client Token>", "鉴权 Header 已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
        </section>

        <section className="api-detail-section">
          <h4><span className="mini-section-icon">▤</span>Anthropic-compatible</h4>
          <div className="api-detail-row">
            <span className="api-detail-label">Base URL</span>
            <Code className="api-detail-value">{baseUrl}/anthropic</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制 Anthropic Base URL" onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">模型列表</span>
            <Code className="api-detail-value">GET /anthropic/v1/models</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制 Anthropic 模型列表地址" onClick={() => void onCopy(`${baseUrl}/anthropic/v1/models`, "Anthropic 模型列表地址已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row">
            <span className="api-detail-label">消息接口</span>
            <Code className="api-detail-value">POST /anthropic/v1/messages</Code>
            <ActionIcon variant="subtle" size="sm" aria-label="复制消息接口地址" onClick={() => void onCopy(`${baseUrl}/anthropic/v1/messages`, "消息接口地址已复制")}>
              <IconCopy size={15} />
            </ActionIcon>
          </div>
          <div className="api-detail-row api-detail-row-multiline">
            <span className="api-detail-label">鉴权 Header</span>
            <Stack gap={4} className="api-detail-stack">
              <Group gap="xs" wrap="nowrap">
                <Code className="api-detail-value">Authorization: Bearer &lt;Client Token&gt;</Code>
                <ActionIcon variant="subtle" size="sm" aria-label="复制 Authorization Header" onClick={() => void onCopy("Authorization: Bearer <Client Token>", "Authorization Header 已复制")}>
                  <IconCopy size={15} />
                </ActionIcon>
              </Group>
              <Group gap="xs" wrap="nowrap">
                <Code className="api-detail-value">X-Api-Key: &lt;Client Token&gt;</Code>
                <ActionIcon variant="subtle" size="sm" aria-label="复制 X-Api-Key Header" onClick={() => void onCopy("X-Api-Key: <Client Token>", "X-Api-Key Header 已复制")}>
                  <IconCopy size={15} />
                </ActionIcon>
              </Group>
            </Stack>
          </div>
        </section>

        <section className="api-detail-section api-detail-security">
          <h4><span className="mini-section-icon">⚠</span>安全提示</h4>
          <ul className="api-detail-warning-list">
            <li>客户端应使用 <Code>Flowlet Client Token</Code>，不要在客户端中直接配置上游渠道的真实 API Key。</li>
            <li>Flowlet 根据 Client Token 识别请求来源，并在转发时替换上游鉴权信息。</li>
          </ul>
        </section>
      </Box>
    </Drawer>
  );
}
