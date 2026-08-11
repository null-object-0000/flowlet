import { useMemo, useState } from "react";
import { IconInfoCircle } from "@douyinfe/semi-icons";
import { ChannelBrandLogoView } from "../desktop/ChannelBrandLogoView";
import { ModelsServiceCapabilityListView, ModelsServiceDetailView, ModelsServiceInfoBannerView, ModelsServiceMetricGridView, ModelsServiceRefreshActionView, ModelsServiceRelationListView, ModelsServiceRouteOverviewView, ModelsServiceSectionView, ModelsServiceTabContentView, ModelsServiceToolbarView, ModelsServiceView, type ModelsServiceItemModel, type ModelsServiceRouteModel } from "../desktop/ModelsServiceView";
import { createModelsServiceFixture } from "./fixtures";
import { DemoPageScaffold } from "./DemoPageScaffold";
import styles from "./ModelsServiceDemoView.module.css";

export function ModelsServiceDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createModelsServiceFixture(zh);
  const [selected, setSelected] = useState("flowlet-pro");
  const [activeTab, setActiveTab] = useState("basic");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries([...fixture.groups.aggregate, ...fixture.groups.direct].map((model) => [model.id, model.enabled])));
  const allModels = useMemo(() => [...fixture.groups.aggregate, ...fixture.groups.direct].map((model) => ({
    ...model,
    logo: <ChannelBrandLogoView channelId={modelChannelId(model)} name={model.name} />,
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
      { key: "basic", label: zh ? "基础信息" : "Basics", content: <BasicDetail zh={zh} model={selectedModel} /> },
      { key: "pricing", label: zh ? "价格信息" : "Pricing", content: <PricingDetail zh={zh} /> },
      { key: "routing", label: zh ? "渠道路由" : "Routes", content: <RoutingDetail zh={zh} model={selectedModel} /> },
    ]}
    footer={<><span>{zh ? "配置变更会立即保存并热更新到本地代理" : "Changes save immediately and hot-update the local proxy"}</span><span>{zh ? "本地配置" : "Local config"}</span></>}
  />;

  return <DemoPageScaffold
    title={zh ? "模型服务" : "Model services"}
    subtitle={zh ? "管理对外模型、渠道能力与请求路由" : "Manage exposed models, channel capabilities and routes"}
    controls={<ModelsServiceRefreshActionView label={zh ? "刷新模型" : "Refresh models"} />}
  >
    <ModelsServiceView
      stats={stats}
      groups={groups}
      labels={{ ...fixture.labels, currentVisible: zh ? `当前显示 ${groups.aggregate.length + groups.direct.length} / 共 ${allModels.length} 个模型` : `Showing ${groups.aggregate.length + groups.direct.length} of ${allModels.length} models` }}
      density={density}
      kindSummary={zh ? "聚合模型 2 · 渠道模型 13" : "2 aggregate · 13 direct"}
      toolbar={<ModelsServiceToolbarView
        search={search}
        searchPlaceholder={zh ? "搜索模型名称或映射模型" : "Search model or mapping"}
        searchLabel={zh ? "搜索模型" : "Search models"}
        channel={channel}
        channelLabel={zh ? "渠道类型" : "Channel"}
        options={[{ value: "all", label: zh ? "全部渠道" : "All channels" }, { value: "deepseek", label: "DeepSeek" }, { value: "qwen", label: "Qwen" }]}
        onSearchChange={setSearch}
        onChannelChange={setChannel}
      />}
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

function modelChannelId(model: ModelsServiceItemModel) {
  if (model.kind === "aggregate") return "flowlet";
  if (model.id.startsWith("deepseek-")) return "deepseek";
  if (model.id.startsWith("glm-")) return "zhipu";
  if (model.id.startsWith("longcat-")) return "longcat";
  if (model.id.startsWith("kimi-")) return "kimi";
  if (model.id.startsWith("qwen")) return "qwen";
  return "unknown";
}

function BasicDetail({ zh, model }: { zh: boolean; model: ModelsServiceItemModel }) {
  const aggregate = model.kind === "aggregate";
  return <ModelsServiceTabContentView>
    {aggregate ? <ModelsServiceInfoBannerView icon={<IconInfoCircle />}>{zh ? "聚合模型参数与能力按当前已启用路由中的最低能力计算。" : "Aggregate limits and capabilities use the lowest enabled route capability."}</ModelsServiceInfoBannerView> : null}
    <ModelsServiceSectionView title={zh ? "模型参数" : "Model parameters"}><ModelsServiceMetricGridView items={[
      { key: "context", label: zh ? "上下文窗口" : "Context window", value: aggregate ? "1M" : "128K" },
      { key: "output", label: zh ? "最大输出" : "Max output", value: "128K" },
      { key: "type", label: zh ? "模型类型" : "Model type", value: aggregate ? (zh ? "Flowlet 聚合" : "Flowlet aggregate") : (zh ? "渠道模型" : "Direct model") },
      { key: "owner", label: zh ? "官方归属" : "Owner", value: aggregate ? (zh ? "多渠道聚合" : "Multi-channel") : modelOwner(model) },
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
  const makeRoute = (key: string, title: string, subtitle: string): ModelsServiceRouteModel => ({
    key,
    title,
    subtitle,
    usable: true,
    enabled: true,
    reorderLabel: zh ? `拖动调整路由 ${subtitle} 的优先级` : `Reorder route ${subtitle}`,
    reorderTitle: zh ? "拖动调整优先级" : "Drag to reorder",
    onlyRouteTitle: zh ? "当前只有一条路由，无需排序" : "Only one route",
    toggleLabel: zh ? `启用路由 ${subtitle}` : `Enable route ${subtitle}`,
    usableLabel: zh ? "可用" : "Available",
    unavailableLabel: zh ? "不可用" : "Unavailable",
    removeLabel: zh ? `从 ${model.name} 移除 ${subtitle}` : `Remove ${subtitle} from ${model.name}`,
    removeTitle: zh ? "删除路由" : "Remove route",
  });
  const [routes, setRoutes] = useState<ModelsServiceRouteModel[]>(() => [
    makeRoute("deepseek", zh ? "DeepSeek · 工作账号" : "DeepSeek · Work account", "deepseek-v4-flash"),
    makeRoute("qwen", "Qwen · Token Plan", "deepseek-v4-flash-0731"),
  ]);
  const reorder = (sourceKey: string, targetKey: string) => setRoutes((current) => {
    const sourceIndex = current.findIndex((route) => route.key === sourceKey);
    const targetIndex = current.findIndex((route) => route.key === targetKey);
    if (sourceIndex < 0 || targetIndex < 0) return current;
    const next = [...current];
    const [moved] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moved);
    return next;
  });
  if (model.kind !== "aggregate") return <ModelsServiceTabContentView>
    <ModelsServiceRouteOverviewView title={zh ? "路由关系" : "Route relationships"} summary={zh ? "1 个聚合模型" : "1 aggregate"} description={zh ? "展示当前渠道模型被哪些聚合模型引用。" : "Shows which aggregate models reference this channel model."} />
    <ModelsServiceRelationListView relations={[{ key: "flowlet-pro", title: "flowlet-pro", subtitle: zh ? "优先级 1" : "Priority 1", enabled: true, activeLabel: zh ? "正在参与路由" : "Active", idleLabel: zh ? "已配置 · 未启用" : "Configured · disabled" }]} />
  </ModelsServiceTabContentView>;
  return <ModelsServiceTabContentView><ModelsServiceRouteOverviewView
    title={zh ? "渠道路由" : "Routes"}
    summary={zh ? `${routes.filter((route) => route.enabled).length} / ${routes.length} 条已启用` : `${routes.filter((route) => route.enabled).length} / ${routes.length} enabled`}
    description={zh ? "从已有渠道模型中自由添加候选，并拖动调整请求优先级。" : "Add candidates from existing channel models and drag to reorder request priority."}
    addLabel={zh ? "添加渠道模型" : "Add channel model"}
    addDisabled={routes.some((route) => route.key === "zai")}
    onAdd={() => setRoutes((current) => [...current, makeRoute("zai", zh ? "Z.AI · 资源包" : "Z.AI · Resource plan", "glm-4.7")])}
    routes={routes}
    removable
    onToggle={(key, value) => setRoutes((current) => current.map((route) => route.key === key ? { ...route, enabled: value } : route))}
    onReorder={reorder}
    onRemove={(key) => setRoutes((current) => current.filter((route) => route.key !== key))}
    empty={zh ? "尚未添加渠道模型。" : "No channel models added."}
  /></ModelsServiceTabContentView>;
}

function modelOwner(model: ModelsServiceItemModel) {
  const channelId = modelChannelId(model);
  if (channelId === "zhipu") return "Z.AI";
  if (channelId === "longcat") return "LongCat";
  if (channelId === "deepseek") return "DeepSeek";
  if (channelId === "kimi") return "Kimi";
  if (channelId === "qwen") return "Qwen";
  return model.typeLabel.split(" · ")[0];
}
