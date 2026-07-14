import { Code, UnstyledButton } from "@mantine/core";

type ClientTokenRowProps = {
  defaultClientToken: string;
  onCopy: (text: string, done: string) => Promise<void>;
};

export function ClientTokenRow({ defaultClientToken, onCopy }: ClientTokenRowProps) {
  if (!defaultClientToken) return null;

  return (
    <UnstyledButton
      type="button"
      className="overview-endpoint-row"
      onClick={() => void onCopy(`Bearer ${defaultClientToken}`, "Client Token 已复制")}
    >
      <span>默认客户端 Token</span>
      <Code className="overview-endpoint-url">{defaultClientToken}</Code>
    </UnstyledButton>
  );
}
