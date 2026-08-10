import { OverviewGridView, OverviewListRowView, OverviewListView, OverviewModuleCardView, OverviewPageView } from "../desktop/OverviewLayoutViews";
import { OverviewServiceStripView } from "../desktop/OverviewServiceStripView";
import { createOverviewServiceFixture } from "./fixtures";

const accounts = [
  ["deepseek-color.svg", "DeepSeek", "余额 86.40 CNY", "Balance 86.40 CNY"],
  ["qwen-color.svg", "Qwen · Token Plan", "7天剩余 72% · 明日重置", "72% left · resets tomorrow"],
  ["longcat-color.svg", "LongCat", "余额 12.60 CNY · 资源包 4.2M Tokens", "12.60 CNY · 4.2M tokens"],
];

const agents = [
  ["claudecode.svg", "Claude Code", "CLI 已安装", "CLI installed"],
  ["opencode.svg", "OpenCode", "CLI 0.28.0 · Desktop 已安装", "CLI 0.28.0 · Desktop installed"],
  ["pi.svg", "Pi", "CLI 已安装", "CLI installed"],
  ["openai.svg", "Codex", "CLI 0.112.0 · Desktop 已安装", "CLI 0.112.0 · Desktop installed"],
];

export function DesktopOverviewDemoView({ zh, density = "default", onOpenUsage }: { zh: boolean; density?: "default" | "compact"; onOpenUsage?: () => void }) {
  const service = createOverviewServiceFixture(zh);
  const icon = (name: string) => <img src={`/icons/lobe/${name}`} alt="" />;
  return (
    <OverviewPageView service={<OverviewServiceStripView density={density} model={service.model} labels={service.labels} onOpenUsage={onOpenUsage} onCopy={(value) => navigator.clipboard?.writeText(value)} onTest={() => new Promise((resolve) => window.setTimeout(resolve, 450))} />}>
      <OverviewGridView
        accounts={<OverviewModuleCardView title={zh ? "渠道账号" : "Model accounts"} meta={zh ? "已启用 3 / 共 3 个账号" : "3 of 3 enabled"} action={zh ? "新增账号" : "Add account"}>
          <OverviewListView>{accounts.map(([asset, title, zhNote, enNote]) => <OverviewListRowView key={title} logo={icon(asset)} title={title} subtitle={zh ? zhNote : enNote} trailing={zh ? "启用" : "Enabled"} />)}</OverviewListView>
        </OverviewModuleCardView>}
        models={<OverviewModuleCardView title={zh ? "聚合模型" : "Aggregate models"} meta={zh ? "共 2 个聚合模型" : "2 aggregate models"} action={zh ? "管理模型" : "Manage"}>
          <OverviewListView>
            <OverviewListRowView logo={<img src="/flowlet-logo.png" alt="" />} title={zh ? "flowlet-pro · 能力优先" : "flowlet-pro · Capability first"} subtitle={zh ? "3 / 3 个模型可用 · 3 / 3 个账号可用" : "3 / 3 models · 3 / 3 accounts"} trailing={zh ? "可用" : "Ready"} />
            <OverviewListRowView logo={<img src="/flowlet-logo.png" alt="" />} title={zh ? "flowlet-flash · 速度优先" : "flowlet-flash · Speed first"} subtitle={zh ? "2 / 2 个模型可用 · 2 / 2 个账号可用" : "2 / 2 models · 2 / 2 accounts"} trailing={zh ? "可用" : "Ready"} />
          </OverviewListView>
        </OverviewModuleCardView>}
        agents={<OverviewModuleCardView title={zh ? "AI Agent 接入" : "AI agent access"}>
          <OverviewListView>{agents.map(([asset, title, zhNote, enNote]) => <OverviewListRowView key={title} logo={icon(asset)} title={title} subtitle={zh ? zhNote : enNote} trailing="›" />)}</OverviewListView>
        </OverviewModuleCardView>}
      />
    </OverviewPageView>
  );
}
