import React from "react";
import { Button, Code, UnstyledButton } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { Panel, PanelHeader } from "../../components/ui";
import { ClientTokenRow } from "./ClientTokenRow";

type ClientAccessCardProps = {
  baseUrl: string;
  defaultClientToken?: string | null;
  onCopy: (text: string, done: string) => Promise<void>;
  onViewDetails: () => void;
};

export function ClientAccessCard({ baseUrl, defaultClientToken, onCopy, onViewDetails }: ClientAccessCardProps) {
  return (
    <Panel className="overview-section-card overview-section-card--grow">
      <PanelHeader>
        <div>
          <h3>客户端访问信息</h3>
        </div>
        <Button className="overview-view-all" variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={onViewDetails}>查看接入详情</Button>
      </PanelHeader>
      <div className="overview-endpoints">
        <UnstyledButton
          type="button"
          className="overview-endpoint-row"
          onClick={() => void onCopy(`${baseUrl}/v1`, "OpenAI Base URL 已复制")}
        >
          <span>OpenAI Base URL</span>
          <Code className="overview-endpoint-url">{baseUrl}/v1</Code>
        </UnstyledButton>
        <UnstyledButton
          type="button"
          className="overview-endpoint-row"
          onClick={() => void onCopy(`${baseUrl}/anthropic`, "Anthropic Base URL 已复制")}
        >
          <span>Anthropic Base URL</span>
          <Code className="overview-endpoint-url">{baseUrl}/anthropic</Code>
        </UnstyledButton>
        <UnstyledButton
          type="button"
          className="overview-endpoint-row"
          onClick={() => void onCopy(`${baseUrl}/health`, "健康检查地址已复制")}
        >
          <span>健康检查地址</span>
          <Code className="overview-endpoint-url">{baseUrl}/health</Code>
        </UnstyledButton>
      </div>
      <ClientTokenRow
        defaultClientToken={defaultClientToken ?? ""}
        onCopy={onCopy}
      />
    </Panel>
  );
}
