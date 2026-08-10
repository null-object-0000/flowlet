import { useMemo, useState } from "react";
import { IconInfoCircle } from "@douyinfe/semi-icons";
import { ModelsServiceCapabilityListView, ModelsServiceDetailView, ModelsServiceInfoBannerView, ModelsServiceMetricGridView, ModelsServiceRouteOverviewView, ModelsServiceSectionView, ModelsServiceTabContentView, ModelsServiceView, type ModelsServiceItemModel } from "../desktop/ModelsServiceView";
import { createModelsServiceFixture } from "./fixtures";
import { DemoFilterToolbar, DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";
import styles from "./ModelsServiceDemoView.module.css";

export function ModelsServiceDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createModelsServiceFixture(zh);
  const [selected, setSelected] = useState("flowlet-pro");
  const [activeTab, setActiveTab] = useState("basic");
  const [search, setSearch] = useState("");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries([...fixture.groups.aggregate, ...fixture.groups.direct].map((model) => [model.id, model.enabled])));
  const allModels = useMemo(() => [...fixture.groups.aggregate, ...fixture.groups.direct].map((model) => ({
    ...model,
    enabled: enabled[model.id],
    toggleLabel: zh ? `${model.name} 对外开放` : `Expose ${model.name}`,
  })), [enabled, fixture.groups.aggregate, fixture.groups.direct, zh]);
  const groups = useMemo(() => ({
    aggregate: allModels.filter((model) => model.kind === "aggregate" && (!search.trim() || [model.name, model.typeLabel].join(" ").toLowerCase().includes(search.trim().toLowerCase()))),
    direct: allModels.filter((model) => model.kind === "direct" && (!search.trim() || [model.name, model.typeLabel].join(" ").toLowerCase().includes(search.trim().toLowerCase()))),
  }), [allModels, search]);
  const selectedModel = allModels.find((model) => model.id === selected) ?? allModels[0];
  const enabledCount = allModels.filter((model) => model.enabled).length;
  const stats = fixture.stats.map((stat) => stat.key === "enabled" ? { ...stat, value: String(enabledCount) } : stat);

  const detail = <ModelsServiceDetailView
    logo={modelLogo(selectedModel)}
    title={selectedModel.name}
    subtitle={`${selectedModel.kind === "aggregate" ? (zh ? "聚合模型" : "Aggregate model") : (zh ? "渠道模型" : "Direct model")} · ${selectedModel.kind === "aggregate" ? (zh ? "2 个可用账号" : "2 available accounts") : selectedModel.typeLabel.split(" · ")[0]}`}
    activeKey={activeTab}
    onTabChange={setActiveTab}
    tabs={[
      { key: "basic", label: zh ? "基础信息" : "Basics", content: <BasicDetail zh={zh} aggregate={selectedModel.kind === "aggregate"} /> },
      { key: "pricing", label: zh ? "价格信息" : "Pricing", content: <PricingDetail zh={zh} /> },
      { key: "routing", label: zh ? "渠道路由" : "Routes", content: <RoutingDetail zh={zh} model={selectedModel} /> },
    ]}
    footer={<><span>{zh ? "配置变更会立即保存并热更新到本地代理" : "Changes save immediately and hot-update the local proxy"}</span><span>{zh ? "本地配置" : "Local config"}</span></>}
  />;

  return <DemoPageScaffold
    title={zh ? "模型服务" : "Model services"}
    subtitle={zh ? "管理对外模型、渠道能力与请求路由" : "Manage exposed models, channel capabilities and routes"}
    controls={<DemoRefreshControl zh={zh} action={zh ? "刷新模型" : "Refresh models"} />}
  >
    <ModelsServiceView
      stats={stats}
      groups={groups}
      labels={{ ...fixture.labels, currentVisible: zh ? `当前显示 ${groups.aggregate.length + groups.direct.length} / 共 ${allModels.length} 个模型` : `Showing ${groups.aggregate.length + groups.direct.length} of ${allModels.length} models` }}
      density={density}
      kindSummary={zh ? "聚合模型 2 · 渠道模型 13" : "2 aggregate · 13 direct"}
      toolbar={<DemoFilterToolbar value={search} placeholder={zh ? "搜索模型名称或映射模型" : "Search model or mapping"} filters={[zh ? "全部渠道" : "All channels"]} onChange={setSearch} />}
      selectedId={selected}
      onSelect={(id) => { setSelected(id); setActiveTab("basic"); }}
      onToggle={(id, value) => setEnabled((current) => ({ ...current, [id]: value }))}
      detail={detail}
    />
  </DemoPageScaffold>;
}

function modelLogo(model: ModelsServiceItemModel) {
  return typeof model.logo === "string" ? <img className={styles.detailLogo} src={model.logo} alt="" /> : model.logo;
}

function BasicDetail({ zh, aggregate }: { zh: boolean; aggregate: boolean }) {
  return <ModelsServiceTabContentView>
    {aggregate ? <ModelsServiceInfoBannerView icon={<IconInfoCircle />}>{zh ? "聚合模型参数与能力按当前已启用路由中的最低能力计算。" : "Aggregate limits and capabilities use the lowest enabled route capability."}</ModelsServiceInfoBannerView> : null}
    <ModelsServiceSectionView title={zh ? "模型参数" : "Model parameters"}><ModelsServiceMetricGridView items={[
      { key: "context", label: zh ? "上下文窗口" : "Context window", value: aggregate ? "1M" : "128K" },
      { key: "output", label: zh ? "最大输出" : "Max output", value: "128K" },
      { key: "type", label: zh ? "模型类型" : "Model type", value: aggregate ? (zh ? "Flowlet 聚合" : "Flowlet aggregate") : (zh ? "渠道模型" : "Direct model") },
      { key: "owner", label: zh ? "官方归属" : "Owner", value: aggregate ? (zh ? "多渠道聚合" : "Multi-channel") : "DeepSeek" },
    ]} /></ModelsServiceSectionView>
    <ModelsServiceSectionView title={zh ? "模型能力" : "Capabilities"}><ModelsServiceCapabilityListView items={[
      { key: "reasoning", label: zh ? "推理" : "Reasoning", value: zh ? "支持" : "Yes", supported: true },
      { key: "tools", label: zh ? "工具调用" : "Tool use", value: zh ? "支持" : "Yes", supported: true },
    ]} /></ModelsServiceSectionView>
  </ModelsServiceTabContentView>;
}

function PricingDetail({ zh }: { zh: boolean }) {
  return <ModelsServiceTabContentView><ModelsServiceInfoBannerView icon={<IconInfoCircle />}>{zh ? "聚合模型展示当前路由候选中的最高预估价格。" : "Aggregate pricing shows the highest estimated route price."}</ModelsServiceInfoBannerView><ModelsServiceSectionView title={zh ? "标准计价" : "Standard pricing"}><ModelsServiceMetricGridView items={[{ key: "input", label: zh ? "输入 / 百万 Token" : "Input / 1M", value: "$0.28" }, { key: "output", label: zh ? "输出 / 百万 Token" : "Output / 1M", value: "$0.42" }]} /></ModelsServiceSectionView></ModelsServiceTabContentView>;
}

function RoutingDetail({ zh, model }: { zh: boolean; model: ModelsServiceItemModel }) {
  return <ModelsServiceTabContentView><ModelsServiceRouteOverviewView title={zh ? "渠道路由" : "Routes"} summary={model.kind === "aggregate" ? (zh ? "2 / 2 条已启用" : "2 / 2 enabled") : (zh ? "1 个聚合模型" : "1 aggregate")} description={zh ? "按顺序选择可用账号，并在失败时自动尝试下一候选。" : "Use accounts in order and fall back to the next candidate on failure."} routes={[
    { key: "deepseek", order: 1, title: zh ? "DeepSeek · 工作账号" : "DeepSeek · Work account", subtitle: "deepseek-v4-flash" },
    { key: "qwen", order: 2, title: "Qwen · Token Plan", subtitle: "deepseek-v4-flash" },
  ]} /></ModelsServiceTabContentView>;
}
