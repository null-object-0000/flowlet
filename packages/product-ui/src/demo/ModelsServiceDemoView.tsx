import { useMemo, useState } from "react";
import { Button } from "@douyinfe/semi-ui-19";
import { IconCopy } from "@douyinfe/semi-icons";
import { ChannelBrandLogoView } from "../desktop/ChannelBrandLogoView";
import { ModelsServiceCapabilityListView, ModelsServiceDetailView, ModelsServiceMetricGridView, ModelsServiceRefreshActionView, ModelsServiceRouteOverviewView, ModelsServiceSectionView, ModelsServiceTabContentView, ModelsServiceToolbarView, ModelsServiceView, type ModelsServiceItemModel, type ModelsServiceRouteModel } from "../desktop/ModelsServiceView";
import { createModelsServiceFixture } from "./fixtures";
import { DemoPageScaffold } from "./DemoPageScaffold";
import styles from "./ModelsServiceDemoView.module.css";

export function ModelsServiceDemoView({ zh, density = "default" }: { zh: boolean; density?: "default" | "compact" }) {
  const fixture = createModelsServiceFixture(zh);
  const [selected, setSelected] = useState(fixture.models[0].id);
  const [activeTab, setActiveTab] = useState("basic");
  const [search, setSearch] = useState("");
  const [channel, setChannel] = useState("all");
  const [enabled, setEnabled] = useState<Record<string, boolean>>(() => Object.fromEntries(fixture.models.map((model) => [model.id, model.enabled])));
  const allModels = useMemo(() => fixture.models.map((model) => ({
    ...model,
    logo: <ChannelBrandLogoView channelId={modelChannelId(model)} name={model.name} />,
    enabled: enabled[model.id],
    toggleLabel: zh ? `${model.name} 对外开放` : `Expose ${model.name}`,
  })), [enabled, fixture.models, zh]);
  const models = useMemo(
    () => allModels.filter((model) => !search.trim() || [model.name, model.typeLabel].join(" ").toLowerCase().includes(search.trim().toLowerCase())),
    [allModels, search],
  );
  const selectedModel = allModels.find((model) => model.id === selected) ?? allModels[0];
  const enabledCount = allModels.filter((model) => model.enabled).length;
  const stats = fixture.stats.map((stat) => stat.key === "enabled" ? { ...stat, value: String(enabledCount) } : stat);

  const detail = <ModelsServiceDetailView
    logo={modelLogo(selectedModel)}
    title={selectedModel.name}
    subtitle={`${zh ? "渠道模型" : "Direct model"} · ${selectedModel.summary}`}
    headerAction={<Button aria-label={zh ? "复制模型名称" : "Copy model name"} title={zh ? "复制模型名称" : "Copy model name"} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void navigator.clipboard?.writeText(selectedModel.name)} />}
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
      models={models}
      labels={{ ...fixture.labels, currentVisible: zh ? `当前显示 ${models.length} / 共 ${allModels.length} 个模型` : `Showing ${models.length} of ${allModels.length} models` }}
      density={density}
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
  if (model.id.startsWith("deepseek-")) return "deepseek";
  if (model.id.startsWith("glm-")) return "zhipu";
  if (model.id.startsWith("longcat-")) return "longcat";
  if (model.id.startsWith("kimi-")) return "kimi";
  if (model.id.startsWith("qwen")) return "qwen";
  return "unknown";
}

function BasicDetail({ zh, model }: { zh: boolean; model: ModelsServiceItemModel }) {
  return <ModelsServiceTabContentView>
    <ModelsServiceSectionView title={zh ? "模型参数" : "Model parameters"}><ModelsServiceMetricGridView items={[
      { key: "context", label: zh ? "上下文窗口" : "Context window", value: "128K" },
      { key: "output", label: zh ? "最大输出" : "Max output", value: "128K" },
      { key: "owner", label: zh ? "官方归属" : "Owner", value: modelOwner(model) },
      { key: "source", label: zh ? "规格来源" : "Specification source", value: "models-cn" },
    ]} /></ModelsServiceSectionView>
    <ModelsServiceSectionView title={zh ? "模型能力" : "Capabilities"}><ModelsServiceCapabilityListView items={[
      { key: "input-modalities", label: zh ? "输入模态" : "Input modalities", value: zh ? "文本 · 图像 · 视频" : "Text · Image · Video" },
      { key: "output-modalities", label: zh ? "输出模态" : "Output modalities", value: zh ? "文本" : "Text" },
      { key: "reasoning", label: zh ? "推理" : "Reasoning", value: zh ? "支持" : "Yes", supported: true },
      { key: "tools", label: zh ? "工具调用" : "Tool use", value: zh ? "支持" : "Yes", supported: true },
    ]} /></ModelsServiceSectionView>
  </ModelsServiceTabContentView>;
}

function PricingDetail({ zh }: { zh: boolean }) {
  return <ModelsServiceTabContentView><ModelsServiceSectionView title={zh ? "标准计价" : "Standard pricing"}><ModelsServiceMetricGridView items={[{ key: "input", label: zh ? "输入 / 百万 Token" : "Input / 1M", value: "$0.28" }, { key: "output", label: zh ? "输出 / 百万 Token" : "Output / 1M", value: "$0.42" }]} /></ModelsServiceSectionView></ModelsServiceTabContentView>;
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
    makeRoute("deepseek", zh ? "DeepSeek · 工作账号" : "DeepSeek · Work account", model.id),
    makeRoute("qwen", "Qwen · Token Plan", `${model.id}-0731`),
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
  return <ModelsServiceTabContentView><ModelsServiceRouteOverviewView
    title={zh ? "渠道路由" : "Routes"}
    summary={zh ? `${routes.filter((route) => route.enabled).length} / ${routes.length} 条已启用` : `${routes.filter((route) => route.enabled).length} / ${routes.length} enabled`}
    description={zh ? "同一模型的多个渠道候选按这里的顺序尝试；可单独启停、拖动排序或删除不再使用的候选。" : "Candidates for the same model are tried in this order; enable, reorder or remove them individually."}
    routes={routes}
    removable
    onToggle={(key, value) => setRoutes((current) => current.map((route) => route.key === key ? { ...route, enabled: value } : route))}
    onReorder={reorder}
    onRemove={(key) => setRoutes((current) => current.filter((route) => route.key !== key))}
    empty={zh ? "尚无路由候选。" : "No route candidates."}
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