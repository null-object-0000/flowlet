import { useEffect, useMemo, useState } from "react";
import { Button, Modal, Select, Toast } from "@douyinfe/semi-ui-19";
import { IconCopy, IconInfoCircle } from "@douyinfe/semi-icons";
import { ModelsServiceCapabilityListView, ModelsServiceDetailView, ModelsServiceInfoBannerView, ModelsServiceMetricGridView, ModelsServiceRefreshActionView, ModelsServiceRelationListView, ModelsServiceRouteListView, ModelsServiceRouteOverviewView, ModelsServiceSectionView, ModelsServiceTabContentView, ModelsServiceToolbarView, ModelsServiceView, type ModelsServiceItemModel, type ModelsServiceRouteModel } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useAccounts, useChannelPresets } from "../../features/channel-accounts";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useRouteCandidates } from "../../features/exposed-models/useModels";
import { PageHeader } from "../../shared/ui/PageHeader";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import {
  buildAggregateRelations,
  buildModelServiceItems,
  type ModelAggregateRelation,
  type ModelRouteGroup,
  type ModelServiceItem,
} from "./modelServiceView";
import {
  addAggregateRouteGroup,
  buildAggregateRouteOptions,
  buildChannelFilterOptions,
  filterModelServiceItems,
  removeAggregateRouteGroup,
  reorderModelRouteGroups,
} from "./modelServiceInteractions";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { formatTokenCapacity, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostAmount } from "../../shared/formatters/cost";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";
import {
  useLocalModelsCnCatalog,
  useLocalModelsDevCatalog,
  resolveChannelModel,
  resolveModelSpecification,
  parseCatalogJson,
  parseModelsDevCatalogJson,
  aggregateMinLimits,
  aggregateCapabilitiesIntersection,
  aggregateMaxPrice,
  aggregateMaxStandardPrice,
  buildPricingStrategyRows,
  effectiveWindowPricesAt,
  hasInputLengthTiers,
  isPromotionalDiscount,
  nextEffectivePricesAt,
} from "../../domains/modelCatalog";
import type { ModelsCnPrice, PricingStrategyRow, ResolvedModel, ResolvedPrice } from "../../domains/modelCatalog";
import { useModelCatalogsSync } from "../../features/background-tasks/useBackgroundTasks";
import { channelCommands, type PresetSyncPreview } from "../../domains/channel/commands";
import styles from "./ModelServicesPage.module.css";

/** 把聚合模型 helper 产出的 ResolvedPrice（扁平 input* 字段）转回 ModelsCnPrice 形态，
 *  方便 UI 统一按 input.standard / input.cacheHit 访问。sourceUrl 仅作兜底。 */
function priceFromResolvedStandard(p: ResolvedPrice): ModelsCnPrice {
  return {
    market: p.market,
    currency: p.currency,
    unit: p.unit,
    rateType: "standard",
    dailyTimeRange: p.dailyTimeRange ?? undefined,
    effectiveFrom: p.effectiveFrom ?? undefined,
    effectiveTo: p.effectiveTo ?? undefined,
    input: {
      standard: p.inputUncached,
      cacheHit: p.inputCached ?? undefined,
      explicitCacheCreation: p.inputCacheWrite ?? undefined,
      explicitCacheHit: p.inputCacheHit ?? undefined,
    },
    output: p.output,
    sourceUrl: p.sourceUrl,
  };
}

function formatDailyPriceRange(price: ModelsCnPrice, t: (source: string) => string): string | null {
  const range = price.dailyTimeRange;
  if (!range) return null;
  const zone = range.timeZone === "Asia/Shanghai" ? t("北京时间") : range.timeZone;
  const intervals = range.intervals
    .map(({ start, end }) => `${start}–${end === "00:00" ? "24:00" : end}`)
    .join("、");
  return `${range.label} · ${zone} ${intervals}`;
}

function StrategyPriceValue({ current, standard, rateType, currency }: {
  current: number | undefined;
  standard: number | undefined;
  rateType: ModelsCnPrice["rateType"];
  currency: string;
}) {
  if (current == null) return <span className={styles.priceUnavailable}>—</span>;
  const showOriginal = standard != null && isPromotionalDiscount(rateType, standard, current);
  return (
    <span className={styles.strategyPrice}>
      {showOriginal ? <span className={styles.priceOriginal}>{formatCostAmount({ amount: standard, currency }, 2)}</span> : null}
      <strong>{formatCostAmount({ amount: current, currency }, 2)}</strong>
    </span>
  );
}

function StrategyPriceMetric({ label, current, standard, rateType, currency }: {
  label: string;
  current: number | undefined;
  standard: number | undefined;
  rateType: ModelsCnPrice["rateType"];
  currency: string;
}) {
  return (
    <div className={styles.strategyMetric}>
      <span>{label}</span>
      <StrategyPriceValue current={current} standard={standard} rateType={rateType} currency={currency} />
    </div>
  );
}

function PricingStrategyCards({ rows, t }: {
  rows: PricingStrategyRow[];
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const showImplicitCache = rows.some((row) => row.current.input.cacheHit != null || row.standard?.input.cacheHit != null);
  const showExplicitCache = rows.some((row) => (
    row.current.input.explicitCacheCreation != null
    || row.current.input.explicitCacheHit != null
    || row.standard?.input.explicitCacheCreation != null
    || row.standard?.input.explicitCacheHit != null
  ));
  const currency = rows[0].current.currency;
  const separatedByTime = rows.some((row) => row.current.dailyTimeRange != null);

  return (
    <div className={`${styles.pricingTierList} ${separatedByTime ? styles.pricingTimeList : ""}`}>
      {rows.map((row) => (
        <section className={styles.pricingTier} key={row.key}>
          <header>
            <strong>{formatDailyPriceRange(row.current, t) ?? row.inputTokenRange?.label ?? t("全部输入")}</strong>
          </header>
          <div className={styles.strategyMetrics}>
            <StrategyPriceMetric label={t("输入")} current={row.current.input.standard} standard={row.standard?.input.standard} rateType={row.current.rateType} currency={currency} />
            <StrategyPriceMetric label={t("输出")} current={row.current.output} standard={row.standard?.output} rateType={row.current.rateType} currency={currency} />
            {showImplicitCache ? (
              <StrategyPriceMetric label={t("隐式命中")} current={row.current.input.cacheHit} standard={row.standard?.input.cacheHit} rateType={row.current.rateType} currency={currency} />
            ) : null}
            {showExplicitCache ? (
              <>
                <StrategyPriceMetric label={t("显式创建")} current={row.current.input.explicitCacheCreation} standard={row.standard?.input.explicitCacheCreation} rateType={row.current.rateType} currency={currency} />
                <StrategyPriceMetric label={t("显式命中")} current={row.current.input.explicitCacheHit} standard={row.standard?.input.explicitCacheHit} rateType={row.current.rateType} currency={currency} />
              </>
            ) : null}
          </div>
        </section>
      ))}
    </div>
  );
}

export function ModelServicesPage() {
  const { language, t } = useAppPreferences();
  const accounts = useAccounts();
  const channels = useChannelPresets();
  const routes = useRouteCandidates();
  // 定价仅用于详情展示，加载失败降级为“—”，不参与页面级 loading/error 聚合。
  // models-cn 目录：只读本地（由后台定时任务拉取）。本地无数据时 catalog 为 null。
  const catalogEntry = useLocalModelsCnCatalog();
  const modelsDevCatalogEntry = useLocalModelsDevCatalog();
  const syncModelCatalogs = useModelCatalogsSync();
  const actions = useModelActions();
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("all");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const models = useMemo(
    () => buildModelServiceItems(routes.data ?? [], accounts.data ?? [], channels.data ?? []),
    [accounts.data, channels.data, routes.data],
  );
  const relations = useMemo(() => buildAggregateRelations(models), [models]);
  const filtered = useMemo(
    () => filterModelServiceItems(models, search, channelFilter),
    [channelFilter, models, search],
  );
  const aggregateModels = useMemo(() => filtered.filter((model) => model.kind === "aggregate"), [filtered]);
  const directModels = useMemo(() => filtered.filter((model) => model.kind === "direct"), [filtered]);

  useEffect(() => {
    if (filtered.length === 0) setSelectedModel(null);
    else if (!selectedModel || !filtered.some((model) => model.publicModel === selectedModel)) {
      setSelectedModel(filtered[0].publicModel);
    }
  }, [filtered, selectedModel]);

  const selected = filtered.find((model) => model.publicModel === selectedModel) ?? null;
  const busyModel = actions.toggleExposedModel.isPending
    ? actions.toggleExposedModel.variables?.modelId
    : actions.reorderRoutes.isPending
      ? actions.reorderRoutes.variables?.modelId
      : actions.updateRoutes.isPending
        ? actions.updateRoutes.variables?.modelId
        : undefined;
  const enabledCount = models.filter((model) => model.enabled).length;
  const aggregateCount = models.filter((model) => model.kind === "aggregate").length;
  const connectedChannelCount = useMemo(
    () => new Set((accounts.data ?? []).map((account) => account.channel_id)).size,
    [accounts.data],
  );
  const loading = accounts.isLoading || channels.isLoading || routes.isLoading;
  const error = accounts.error ?? channels.error ?? routes.error;

  const [syncPreview, setSyncPreview] = useState<PresetSyncPreview | null>(null);
  const [syncPending, setSyncPending] = useState(false);
  const [syncApplying, setSyncApplying] = useState(false);

  const refresh = () => void Promise.all([accounts.refetch(), routes.refetch(), catalogEntry.refetch()]);
  const syncCatalogs = () => syncModelCatalogs.mutate({ modelsCnUrl: "https://null-object-0000.github.io/models-cn/api.json", modelsDevUrl: "https://models.dev/api.json", triggerSource: "manual" });
  const openSyncPresets = async () => {
    setSyncPending(true);
    try {
      const preview = await channelCommands.previewSyncPresets();
      setSyncPreview(preview);
    } catch {
      setSyncPreview(null);
    } finally {
      setSyncPending(false);
    }
  };
  const closeSyncPresets = () => setSyncPreview(null);
  const applySyncPresets = async () => {
    if (!syncPreview?.hasChanges) {
      closeSyncPresets();
      return;
    }
    setSyncApplying(true);
    try {
      await channelCommands.applySyncPresets();
      await Promise.all([channels.refetch(), routes.refetch(), accounts.refetch()]);
      closeSyncPresets();
    } catch {
      // 失败时保留 modal 显示错误
    } finally {
      setSyncApplying(false);
    }
  };
  const toggleModel = (model: ModelServiceItem, enabled: boolean) => {
    actions.toggleExposedModel.mutate({ routes: routes.data ?? [], routeIds: model.routeIds, modelId: model.publicModel, enabled });
  };
  const toggleRoute = (modelId: string, routeGroup: ModelRouteGroup, enabled: boolean) => {
    actions.toggleExposedModel.mutate({ routes: routes.data ?? [], routeIds: routeGroup.routeIds, modelId, enabled });
  };
  const reorderRoute = (modelId: string, sourceKey: string, targetKey: string) => {
    const currentRoutes = routes.data ?? [];
    const nextRoutes = reorderModelRouteGroups(
      currentRoutes,
      modelId,
      sourceKey,
      targetKey,
      new Date().toISOString(),
    );
    if (nextRoutes === currentRoutes) return;
    actions.reorderRoutes.mutate({ routes: currentRoutes, nextRoutes, modelId });
  };
  const addAggregateRoute = (modelId: string, sourceKey: string) => {
    const currentRoutes = routes.data ?? [];
    const now = new Date().toISOString();
    const nextRoutes = addAggregateRouteGroup(
      currentRoutes,
      modelId,
      sourceKey,
      now,
      () => `route-${crypto.randomUUID()}`,
    );
    if (nextRoutes === currentRoutes) return;
    actions.updateRoutes.mutate({
      routes: currentRoutes,
      nextRoutes,
      modelId,
      message: t("已添加到 {model}", { model: modelId }),
    });
  };
  const removeAggregateRoute = (modelId: string, routeGroup: ModelRouteGroup) => {
    const currentRoutes = routes.data ?? [];
    const nextRoutes = removeAggregateRouteGroup(currentRoutes, modelId, routeGroup.routeIds);
    actions.updateRoutes.mutate({
      routes: currentRoutes,
      nextRoutes,
      modelId,
      message: t("已从 {model} 移除", { model: modelId }),
    });
  };

  const toViewModel = (model: ModelServiceItem): ModelsServiceItemModel => {
    const modelRelations = relations.get(model.publicModel.toLowerCase()) ?? [];
    const relatedAggregateCount = new Set(modelRelations.map((relation) => relation.aggregateModel)).size;
    const summary = model.kind === "aggregate"
      ? (model.availableAccountCount > 0 ? t("{count} 个可用账号", { count: model.availableAccountCount }) : t("无可用账号"))
      : (relatedAggregateCount > 0 ? t("已加入 {count} 个聚合模型", { count: relatedAggregateCount }) : t("尚未加入路由"));
    const summaryMuted = model.kind === "aggregate" ? model.availableAccountCount === 0 : relatedAggregateCount === 0;
    const typeLabel = model.kind === "aggregate"
      ? t("Flowlet · 聚合模型")
      : t("{channel} · 渠道模型", { channel: model.channelName ?? model.channelId ?? "—" });
    return {
      id: model.publicModel,
      kind: model.kind,
      name: model.publicModel,
      typeLabel,
      summary,
      summaryMuted,
      enabled: model.enabled,
      logo: <ModelLogo model={model} />,
      toggleLabel: t("{model} 对外开放", { model: model.publicModel }),
      toggleLoading: busyModel === model.publicModel,
      toggleDisabled: busyModel != null || model.routeIds.length === 0,
    };
  };
  const viewGroups = { aggregate: aggregateModels.map(toViewModel), direct: directModels.map(toViewModel) };

  return (
    <main className={styles.page}>
      <PageHeader title={t("模型服务")} subtitle={t("管理对外模型、渠道能力与请求路由")}>
        <ModelsServiceRefreshActionView label={t("刷新模型")} onClick={openSyncPresets} loading={syncPending} />
      </PageHeader>

      {error ? <div className={styles.state}><strong>{t("模型服务加载失败")}</strong><span>{error.message}</span><Button onClick={refresh}>{t("重试")}</Button></div> : null}
      {!error ? <ModelsServiceView
        stats={[
          { key: "models", label: t("对外模型"), value: String(models.length) },
          { key: "enabled", label: t("已启用"), value: String(enabledCount), tone: "success" },
          { key: "channels", label: t("已接入渠道"), value: String(connectedChannelCount) },
        ]}
        groups={viewGroups}
        labels={{
          stats: {},
          statsAria: t("模型服务统计"),
          aggregateGroup: t("聚合模型"),
          directGroup: t("渠道模型"),
          currentVisible: t("当前显示 {visible} / 共 {total} 个模型", { visible: filtered.length, total: models.length }),
          hint: t("选择模型后在右侧查看详情"),
          ready: t("可用"),
          off: t("关闭"),
          empty: loading ? t("正在加载模型…") : (models.length ? t("没有匹配的模型") : t("暂无模型，请先添加渠道账号")),
        }}
        kindSummary={t("聚合模型 {aggregate} · 渠道模型 {direct}", { aggregate: aggregateCount, direct: models.length - aggregateCount })}
        loading={loading}
        selectedId={selectedModel}
        onSelect={setSelectedModel}
        onToggle={(id, checked) => {
          const model = filtered.find((item) => item.publicModel === id);
          if (model) toggleModel(model, checked);
        }}
        toolbar={<ModelsServiceToolbarView
          search={search}
          searchPlaceholder={t("搜索模型名称或映射模型")}
          searchLabel={t("搜索模型")}
          channel={channelFilter}
          channelLabel={t("渠道类型")}
          options={[{ value: "all", label: t("全部渠道") }, ...buildChannelFilterOptions(models, channels.data ?? [])]}
          onSearchChange={setSearch}
          onChannelChange={setChannelFilter}
        />}
        detail={<ModelDetail
          model={selected}
          relations={relations}
          accounts={accounts.data ?? []}
          channels={channels.data ?? []}
          allRoutes={routes.data ?? []}
          catalogJson={catalogEntry.data ?? null}
          modelsDevCatalogJson={modelsDevCatalogEntry.data ?? null}
          modelsDevCatalogLoading={modelsDevCatalogEntry.isLoading}
          catalogLoading={catalogEntry.isLoading}
          syncCatalogsPending={syncModelCatalogs.isPending}
          onSyncCatalogs={syncCatalogs}
          language={language}
          pendingModel={busyModel}
          onToggleRoute={toggleRoute}
          onReorderRoute={reorderRoute}
          onAddAggregateRoute={addAggregateRoute}
          onRemoveAggregateRoute={removeAggregateRoute}
          t={t}
        />}
      /> : null}

      {syncPreview ? (
        <PresetSyncModal
          t={t}
          preview={syncPreview}
          applying={syncApplying}
          onCancel={closeSyncPresets}
          onConfirm={applySyncPresets}
        />
      ) : null}
    </main>
  );
}

function PresetSyncModal({ t, preview, applying, onCancel, onConfirm }: {
  t: (source: string, values?: Record<string, string | number>) => string;
  preview: PresetSyncPreview;
  applying: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const statusLabel = (status: string) => {
    if (status === "added") return t("新增");
    if (status === "removed") return t("移除");
    return t("更新");
  };
  const statusTone = (status: string) => {
    if (status === "added") return styles.added;
    if (status === "removed") return styles.removed;
    return styles.updated;
  };
  return (
    <Modal
      title={t("同步渠道预设")}
      visible
      zIndex={APP_OVERLAY_Z_INDEX.modal}
      onCancel={onCancel}
      footer={(
        <div className={styles.syncFooter}>
          <Button onClick={onCancel}>{t("取消")}</Button>
          <Button
            theme="solid"
            type="primary"
            disabled={!preview.hasChanges}
            loading={applying}
            onClick={onConfirm}
          >
            {t("确认同步")}
          </Button>
        </div>
      )}
    >
      <div className={styles.syncBody}>
        {preview.hasChanges ? (
          <>
            {preview.items.length > 0 ? (
              <>
                <p className={styles.syncSummary}>
                  {t("发现以下渠道预设变更：")}
                  <span className={styles.syncCounts}>
                    {preview.addedCount > 0 ? <span className={styles.added}>+{preview.addedCount}</span> : null}
                    {preview.removedCount > 0 ? <span className={styles.removed}>-{preview.removedCount}</span> : null}
                    {preview.updatedCount > 0 ? <span className={styles.updated}>~{preview.updatedCount}</span> : null}
                  </span>
                </p>
                <div className={styles.syncList}>
                  {preview.items.map((item) => (
                    <div className={styles.syncRow} key={`${item.status}-${item.id}`}>
                      <span className={`${styles.syncStatus} ${statusTone(item.status)}`}>{statusLabel(item.status)}</span>
                      <span className={styles.syncName}><strong>{item.name}</strong><small>{item.id}</small></span>
                      <span className={styles.syncDetail}>
                        {item.before ? <span className={styles.syncBefore}>{item.before}</span> : null}
                        {item.before && item.after ? <span className={styles.syncArrow}>→</span> : null}
                        {item.after ? <span className={styles.syncAfter}>{item.after}</span> : null}
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
            {preview.newExposedModels.length > 0 ? (
              <>
                <p className={styles.syncSummary}>
                  {t("以下模型缺少路由（同步后自动补齐）：")}
                  <span className={styles.syncCounts}>
                    <span className={styles.added}>+{preview.newExposedModels.length}</span>
                  </span>
                </p>
                <div className={styles.syncList}>
                  {preview.newExposedModels.map((m) => (
                    <div className={styles.syncRow} key={`new-${m.channelId}-${m.modelId}`}>
                      <span className={`${styles.syncStatus} ${styles.added}`}>{t("新增")}</span>
                      <span className={styles.syncName}>{m.channelName}</span>
                      <span className={styles.syncDetail}>
                        <span className={styles.syncAfter}>{m.modelId}</span>
                      </span>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </>
        ) : (
          <div className={styles.syncEmpty}>{t("无变更，渠道预设已是最新。")}</div>
        )}
      </div>
    </Modal>
  );
}

function ModelLogo({ model }: { model: ModelServiceItem }) {
  if (model.kind === "direct") return <ChannelBrandLogo channelId={model.channelId ?? "flowlet"} name={model.channelName ?? model.publicModel} />;
  return <FlowletLogo variant="model" />;
}

function ModelDetail({ model, relations, accounts, channels, allRoutes, catalogJson, modelsDevCatalogJson, catalogLoading, modelsDevCatalogLoading, syncCatalogsPending, onSyncCatalogs, language, pendingModel, onToggleRoute, onReorderRoute, onAddAggregateRoute, onRemoveAggregateRoute, t }: {
  model: ModelServiceItem | null;
  relations: Map<string, ModelAggregateRelation[]>;
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  allRoutes: RouteCandidate[];
  catalogJson: string | null;
  modelsDevCatalogJson: string | null;
  catalogLoading: boolean;
  modelsDevCatalogLoading: boolean;
  syncCatalogsPending: boolean;
  onSyncCatalogs: () => void;
  language: NumberLanguage;
  pendingModel: string | undefined;
  onToggleRoute: (modelId: string, routeGroup: ModelRouteGroup, enabled: boolean) => void;
  onReorderRoute: (modelId: string, sourceKey: string, targetKey: string) => void;
  onAddAggregateRoute: (modelId: string, sourceKey: string) => void;
  onRemoveAggregateRoute: (modelId: string, routeGroup: ModelRouteGroup) => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const [addRouteVisible, setAddRouteVisible] = useState(false);
  const [selectedRouteKey, setSelectedRouteKey] = useState<string>();
  const [activeTab, setActiveTab] = useState("basic");
  const [pricingNow, setPricingNow] = useState(() => new Date());

  useEffect(() => {
    if (activeTab !== "pricing") return undefined;
    setPricingNow(new Date());
    const interval = window.setInterval(() => setPricingNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, [activeTab]);

  // 解析本地 models-cn.json 文件内容。必须放在所有提前返回之前，
  // 保证每次渲染 hook 调用顺序一致（Rules of Hooks）。
  const catalog = useMemo(() => (catalogJson ? parseCatalogJson(catalogJson) : null), [catalogJson]);
  const modelsDevCatalog = useMemo(
    () => (modelsDevCatalogJson ? parseModelsDevCatalogJson(modelsDevCatalogJson) : null),
    [modelsDevCatalogJson],
  );

  // 直接模型规格按 models-cn → models.dev 回退。
  const directResolved: ResolvedModel | null = useMemo(() => {
    if (!model || model.kind !== "direct") return null;
    for (const route of model.routeGroups) {
      const resolved = resolveModelSpecification(
        catalog,
        modelsDevCatalog,
        route.channelId,
        route.upstreamModel,
        pricingNow,
        !catalogLoading && !modelsDevCatalogLoading,
      );
      if (resolved) return resolved;
    }
    return model.channelId
      ? resolveModelSpecification(
        catalog,
        modelsDevCatalog,
        model.channelId,
        model.publicModel,
        pricingNow,
        !catalogLoading && !modelsDevCatalogLoading,
      )
      : null;
  }, [catalog, catalogLoading, model, modelsDevCatalog, modelsDevCatalogLoading, pricingNow]);

  // 聚合模型（flowlet-pro/flowlet-flash）：只汇总已启用子路由的 limits/caps/prices。
  // limits 取最小值（木桶效应）、caps 取交集（只承诺所有子模型都支持的能力）、
  // prices 取最大值（展示最坏情况下的成本上限）。
  const aggregateResolved: ResolvedModel | null = useMemo(() => {
    if (!model || model.kind !== "aggregate") return null;
    const subModels: ResolvedModel[] = [];
    for (const route of model.routeGroups) {
      if (!route.enabled) continue;
      const resolved = resolveModelSpecification(
        catalog,
        modelsDevCatalog,
        route.channelId,
        route.upstreamModel,
        pricingNow,
        !catalogLoading && !modelsDevCatalogLoading,
      );
      if (resolved) subModels.push(resolved);
    }
    if (subModels.length === 0) return null;
    const officialPrice = aggregateMaxPrice(subModels);
    const limits = aggregateMinLimits(subModels);
    const capabilities = aggregateCapabilitiesIntersection(subModels);
    const sources = new Set(subModels.map((subModel) => subModel.specificationSource));
    return {
      providerId: "flowlet",
      providerName: "Flowlet",
      modelId: model.publicModel,
      modelName: model.publicModel,
      description: null,
      tokenizer: null,
      specificationSource: sources.size === 1 ? subModels[0].specificationSource : "mixed",
      limits,
      capabilities,
      aliases: [],
      officialPrice,
      allPrices: [],
      supplementedFromModelsDev: false,
      modelsDevReferenceUrl: null,
    };
  }, [catalog, catalogLoading, model, modelsDevCatalog, modelsDevCatalogLoading, pricingNow]);

  // 当前模型实际使用的 resolved 数据源。
  const resolved = model?.kind === "aggregate" ? aggregateResolved : directResolved;

  // 聚合模型的划价展示：用旗下已启用子模型的 standard 价格取最大值，与当前（promotional）对比。
  const aggregateStandardPrice = useMemo(() => {
    if (!model || model.kind !== "aggregate" || !catalog || !resolved?.officialPrice) return null;
    const subModels: ResolvedModel[] = [];
    for (const route of model.routeGroups) {
      if (!route.enabled) continue;
      const resolvedSub = resolveChannelModel(catalog, route.channelId, route.upstreamModel, pricingNow);
      if (resolvedSub) subModels.push(resolvedSub);
    }
    if (subModels.length === 0) return null;
    return aggregateMaxStandardPrice(subModels, pricingNow);
  }, [catalog, model, pricingNow, resolved?.officialPrice]);

  // 基础信息：优先 models-cn 官方值，缺失降级到渠道同步。
  if (!model) return <ModelsServiceDetailView empty={t("选择一个模型查看路由配置")} />;

  const busy = pendingModel != null;
  const modelRelations = relations.get(model.publicModel.toLowerCase()) ?? [];
  const relatedAggregateCount = new Set(modelRelations.map((relation) => relation.aggregateModel)).size;
  const kindLabel = model.kind === "aggregate" ? t("聚合模型") : t("渠道模型");
  const accountLabel = model.availableAccountCount > 0
    ? t("{count} 个可用账号", { count: model.availableAccountCount })
    : t("无可用账号");
  const enabledRouteCount = model.routeGroups.filter((routeGroup) => routeGroup.enabled).length;
  const aggregateRouteOptions = model.kind === "aggregate"
    ? buildAggregateRouteOptions(allRoutes, model.publicModel)
    : [];
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const routeViewModels: ModelsServiceRouteModel[] = model.routeGroups.map((routeGroup) => {
    const account = accountById.get(routeGroup.accountId);
    const usable = Boolean(account?.enabled && account.api_key.trim() && account.credential_status !== "invalid_key");
    return {
      key: routeGroup.key,
      title: <>{channelById.get(routeGroup.channelId)?.name ?? routeGroup.channelId} · {account?.name ?? routeGroup.accountId}</>,
      subtitle: <>{routeGroup.upstreamModel} · {t(routeGroup.enabled ? "参与当前路由" : "当前未启用")}</>,
      usable,
      enabled: routeGroup.enabled,
      reorderLabel: t("拖动调整路由 {name} 的优先级", { name: routeGroup.upstreamModel }),
      reorderTitle: t("拖动调整优先级"),
      onlyRouteTitle: t("当前只有一条路由，无需排序"),
      toggleLabel: t("启用路由 {name}", { name: routeGroup.upstreamModel }),
      usableLabel: t("可用"),
      unavailableLabel: t("不可用"),
      removeLabel: t("从 {model} 移除 {name}", { model: model.publicModel, name: routeGroup.upstreamModel }),
      removeTitle: t("删除路由"),
    };
  });
  const toggleViewRoute = (key: string, enabled: boolean) => {
    const routeGroup = model.routeGroups.find((route) => route.key === key);
    if (routeGroup) onToggleRoute(model.publicModel, routeGroup, enabled);
  };
  const removeViewRoute = (key: string) => {
    const routeGroup = model.routeGroups.find((route) => route.key === key);
    if (routeGroup) onRemoveAggregateRoute(model.publicModel, routeGroup);
  };

  // 聚合模型（flowlet-pro/flowlet-flash）没有厂商官方价格，不展示"立即同步"。
  const showPricingSync = model.kind === "direct";
  const copyModelName = async () => {
    try {
      await navigator.clipboard.writeText(model.publicModel);
      Toast.success(t("已复制"));
    } catch {
      Toast.error(t("复制失败"));
    }
  };

  return <ModelsServiceDetailView
    logo={<ModelLogo model={model} />}
    title={model.publicModel}
    subtitle={`${kindLabel} · ${accountLabel}`}
    headerAction={<Button aria-label={t("复制模型名称")} title={t("复制模型名称")} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copyModelName()} />}
    activeKey={activeTab}
    onTabChange={setActiveTab}
    tabs={[
      { key: "basic", label: t("基础信息"), content: <>
          <ModelBasicInfoTab resolved={resolved} isAggregate={model.kind === "aggregate"} channelName={model.channelName} language={language} t={t} />
        </> },
      { key: "pricing", label: t("价格信息"), content: <>
          <ModelPricingTab
            resolved={resolved}
            standardPrice={model.kind === "direct" ? undefined : aggregateStandardPrice}
            hasCatalog={catalog !== null}
            catalogLoading={catalogLoading}
            showSyncButton={showPricingSync}
            isAggregate={model.kind === "aggregate"}
            syncPending={syncCatalogsPending}
            onSync={onSyncCatalogs}
            at={pricingNow}
            language={language}
            t={t}
          />
        </> },
      { key: "routing", label: t("渠道路由"), content: <>
          {model.kind === "aggregate" ? (
            <ModelsServiceTabContentView>
              <ModelsServiceRouteOverviewView
                title={t("渠道路由")}
                summary={t("{enabled} / {total} 条已启用", { enabled: enabledRouteCount, total: model.routeGroups.length })}
                description={t("从已有渠道模型中自由添加候选，并拖动调整请求优先级。")}
                addLabel={t("添加渠道模型")}
                addDisabled={aggregateRouteOptions.length === 0}
                onAdd={() => setAddRouteVisible(true)}
                routes={routeViewModels}
                busy={busy}
                removable
                empty={t("尚未添加渠道模型。添加后，Flowlet 会按这里的顺序选择候选。")}
                onToggle={toggleViewRoute}
                onReorder={(sourceKey, targetKey) => onReorderRoute(model.publicModel, sourceKey, targetKey)}
                onRemove={removeViewRoute}
              />
              <Modal
                title={t("添加渠道模型到 {model}", { model: model.publicModel })}
                visible={addRouteVisible}
                zIndex={APP_OVERLAY_Z_INDEX.modal}
                onCancel={() => { setAddRouteVisible(false); setSelectedRouteKey(undefined); }}
                onOk={() => {
                  if (!selectedRouteKey) return;
                  onAddAggregateRoute(model.publicModel, selectedRouteKey);
                  setAddRouteVisible(false);
                  setSelectedRouteKey(undefined);
                }}
                okButtonProps={{ disabled: !selectedRouteKey, loading: busy }}
                okText={t("添加")}
                cancelText={t("取消")}
              >
                <div className={styles.addRouteForm}>
                  <span>{t("选择已有渠道模型")}</span>
                  <Select
                    value={selectedRouteKey}
                    zIndex={APP_OVERLAY_Z_INDEX.modal + 1}
                    onChange={(value) => setSelectedRouteKey(String(value))}
                    placeholder={t("选择渠道、账号和模型")}
                    filter
                    optionList={aggregateRouteOptions.map((option) => ({
                      value: option.key,
                      label: `${channelById.get(option.channelId)?.name ?? option.channelId} · ${accountById.get(option.accountId)?.name ?? option.accountId} · ${option.upstreamModel}`,
                    }))}
                  />
                  <small>{t("同一渠道模型支持的协议会一起加入；之后仍可单独停用或移除。")}</small>
                </div>
              </Modal>
            </ModelsServiceTabContentView>
          ) : (
            <ModelsServiceTabContentView>
              <ModelsServiceRouteOverviewView
                title={t("路由关系")}
                summary={t("{count} 个聚合模型", { count: relatedAggregateCount })}
                description={t("展示当前渠道模型被哪些聚合模型引用。")}
              />
              {modelRelations.length > 0 ? (
                <ModelsServiceRelationListView relations={modelRelations.map((relation) => ({
                  key: `${relation.aggregateModel}-${relation.routeGroupKey}`,
                  logo: <FlowletLogo variant="model" />,
                  title: relation.aggregateModel,
                  subtitle: t("优先级 {priority}", { priority: relation.priority }),
                  enabled: relation.enabled,
                  activeLabel: t("正在参与路由"),
                  idleLabel: t("已配置 · 未启用"),
                }))} />
              ) : (
                <ModelsServiceInfoBannerView icon={<IconInfoCircle />}>
                  {t("该渠道模型尚未加入任何聚合模型。可在聚合模型的「渠道路由」中添加。")}
                </ModelsServiceInfoBannerView>
              )}
              {model.routeGroups.length > 1 ? (
                <ModelsServiceSectionView title={t("直连路由")} note={t("按账号启停或拖动调整优先级")}>
                  <ModelsServiceRouteListView routes={routeViewModels} busy={busy} framed={false} onToggle={toggleViewRoute} onReorder={(sourceKey, targetKey) => onReorderRoute(model.publicModel, sourceKey, targetKey)} />
                </ModelsServiceSectionView>
              ) : null}
            </ModelsServiceTabContentView>
          )}
        </> },
    ]}
    footer={<><span>{t("配置变更会立即保存并热更新到本地代理")}</span><span>{t("本地配置")}</span></>}
  />;
}

function DetailSection({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className={styles.detailSection}><header><strong>{title}</strong>{note ? <span>{note}</span> : null}</header><div className={styles.configBox}>{children}</div></section>;
}

const MODEL_MODALITY_LABELS: Record<string, string> = {
  text: "文本",
  image: "图像",
  video: "视频",
  audio: "音频",
  file: "文件",
};

function formatModelModalities(
  modalities: string[],
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (modalities.length === 0) return "—";
  return modalities.map((modality) => t(MODEL_MODALITY_LABELS[modality] ?? modality)).join(" · ");
}

function modelSpecificationSourceLabel(
  resolved: ResolvedModel | null,
  isAggregate: boolean,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (isAggregate) return t("聚合计算");
  if (resolved?.specificationSource === "models-cn") return "models-cn";
  if (resolved?.specificationSource === "models.dev") return "models.dev";
  return "—";
}

function modelSpecificationDescription(
  resolved: ResolvedModel | null,
  isAggregate: boolean,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (isAggregate) return t("参数与能力按当前已启用路由的最低值计算。");
  if (resolved?.specificationSource === "models-cn") return t("当前展示 models-cn 收录的模型规格。");
  if (resolved?.specificationSource === "models.dev") return t("models-cn 暂未收录，当前展示 models.dev 的模型规格。");
  return t("暂无可用的模型规格。");
}

/** 基础信息 Tab：顶部说明 banner + 2×2 参数网格 + 能力清单。优先展示 models-cn 官方值。
 *  聚合模型（flowlet-pro/flowlet-flash）：limits 取已启用子模型最小值（木桶效应），
 *  capabilities 取交集（只承诺所有子模型都支持的能力）。 */
function ModelBasicInfoTab({ resolved, isAggregate, channelName, language, t }: {
  resolved: ResolvedModel | null;
  isAggregate: boolean;
  channelName?: string;
  language: NumberLanguage;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const contextTokens = resolved?.limits.contextTokens ?? null;
  const maxOutputTokens = resolved?.limits.maxOutputTokens ?? null;
  const caps = resolved?.capabilities;
  return (
    <ModelsServiceTabContentView>
      <ModelsServiceInfoBannerView icon={<IconInfoCircle />}>
        {modelSpecificationDescription(resolved, isAggregate, t)}
      </ModelsServiceInfoBannerView>
      <ModelsServiceSectionView title={t("模型参数")}><ModelsServiceMetricGridView items={[
        { key: "context", label: t("上下文窗口"), value: formatTokenCapacity(contextTokens, language) },
        { key: "output", label: t("最大输出"), value: formatTokenCapacity(maxOutputTokens, language) },
        { key: "owner", label: t("官方归属"), value: isAggregate ? "Flowlet" : resolved?.providerName ?? channelName ?? "—" },
        { key: "source", label: t("规格来源"), value: modelSpecificationSourceLabel(resolved, isAggregate, t) },
      ]} /></ModelsServiceSectionView>
      {caps ? (
        <ModelsServiceSectionView title={t("模型能力")}><ModelsServiceCapabilityListView items={[
          { key: "input-modalities", label: t("输入模态"), value: formatModelModalities(caps.inputModalities, t) },
          { key: "output-modalities", label: t("输出模态"), value: formatModelModalities(caps.outputModalities, t) },
          { key: "thinking", label: t("推理"), value: caps.thinking ? t("支持") : t("不支持"), supported: caps.thinking },
          { key: "tools", label: t("工具调用"), value: caps.toolCalls ? t("支持") : t("不支持"), supported: caps.toolCalls },
          { key: "json", label: t("JSON 输出"), value: caps.jsonOutput ? t("支持") : t("不支持"), supported: caps.jsonOutput },
        ]} /></ModelsServiceSectionView>
      ) : null}
      {resolved?.description ? (
        <DetailSection title={t("模型说明")}>
          <p className={styles.modelDescription}>{resolved.description}</p>
        </DetailSection>
      ) : null}
      {resolved?.aliases?.length ? (
        <DetailSection title={t("模型别名")}>
          {resolved.aliases.map((alias) => (
            <div className={styles.configRow} key={alias.id}><span>{alias.mode}</span><strong>{alias.id}</strong></div>
          ))}
        </DetailSection>
      ) : null}
      {resolved?.supplementedFromModelsDev ? (
        <div className={styles.infoFootnote}>
          <span>{t("部分字段由 models.dev 补全")}</span>
          {resolved.modelsDevReferenceUrl ? <a href={resolved.modelsDevReferenceUrl} target="_blank" rel="noreferrer">{t("参考链接")}</a> : null}
        </div>
      ) : null}
    </ModelsServiceTabContentView>
  );
}

/** 价格信息 Tab：展示 models-cn 官方价格（与渠道账号无关的厂商直销价）。
 *  数据完全来自 models-cn，不再有 config.json 降级。
 *  聚合模型（flowlet-pro/flowlet-flash）：价格取已启用子模型的最大值（展示最坏情况
 *  下的成本上限），standard 价格也取最大值用于划价展示。 */
function ModelPricingTab({ resolved, standardPrice: standardPriceOverride, hasCatalog, catalogLoading, showSyncButton, isAggregate, syncPending, onSync, at, language, t }: {
  resolved: ResolvedModel | null;
  standardPrice?: ResolvedPrice | null;
  hasCatalog: boolean;
  catalogLoading: boolean;
  showSyncButton: boolean;
  isAggregate: boolean;
  syncPending: boolean;
  onSync: () => void;
  at: Date;
  language: NumberLanguage;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const price = resolved?.officialPrice;
  const unitLabel = price && price.unit !== "1M_tokens" ? price.unit : t("百万 tokens");
  const formatPrice = (amount: number, currency: string) => formatCostAmount({ amount, currency }, 2);

  if (!price) {
    return (
      <ModelsServiceTabContentView>
        {hasCatalog || !showSyncButton ? (
          <div className={styles.empty}>{t("暂无官方价格数据")}</div>
        ) : (
          <div className={styles.empty}>
            <span>{catalogLoading ? t("正在加载 models-cn 数据…") : t("本地暂无 models-cn 数据，后台定时任务将自动拉取。")}</span>
            <Button theme="borderless" type="tertiary" size="small" onClick={onSync} loading={syncPending}>{t("立即同步")}</Button>
          </div>
        )}
      </ModelsServiceTabContentView>
    );
  }

  // 划价展示用的 standard 价格：聚合模型用外部传入（子模型 standard 最大值），
  // 直接模型从 allPrices 中取同市场同币种的 standard。统一按 ModelsCnPrice 形态
  // 处理，便于直接访问 input.standard / input.cacheHit。
  const matchingPrices = (resolved?.allPrices ?? []).filter(
    (candidate) => candidate.market === price.market && candidate.currency === price.currency,
  );
  const currentWindowPrices = effectiveWindowPricesAt(matchingPrices, at);
  const upcomingPrices = nextEffectivePricesAt(matchingPrices, at);
  const standardPrice: ModelsCnPrice | null = standardPriceOverride
    ? priceFromResolvedStandard(standardPriceOverride)
    : currentWindowPrices.find((candidate) => candidate.rateType === "standard") ?? null;
  const strategyRows = !isAggregate
    ? buildPricingStrategyRows(currentWindowPrices, price.market, price.currency)
    : [];
  const upcomingStrategyRows = !isAggregate && upcomingPrices.length > 0
    ? buildPricingStrategyRows(upcomingPrices, price.market, price.currency)
    : [];
  const hasDailyTimeRanges = strategyRows.some((row) => row.current.dailyTimeRange != null);
  // 输入分档、峰谷时段或即将生效价格使用策略卡片；普通单档价格仍走扁平布局。
  const showDetailedStrategy = hasInputLengthTiers(strategyRows)
    || hasDailyTimeRanges
    || upcomingStrategyRows.length > 0;
  const showInputOriginal = standardPrice != null
    && isPromotionalDiscount(price.rateType, standardPrice.input.standard, price.inputUncached);
  const showCachedOriginal = standardPrice?.input.cacheHit != null
    && isPromotionalDiscount(price.rateType, standardPrice.input.cacheHit, price.inputCached ?? 0);
  const showCacheWriteOriginal = standardPrice?.input.explicitCacheCreation != null
    && isPromotionalDiscount(
      price.rateType,
      standardPrice.input.explicitCacheCreation,
      price.inputCacheWrite ?? 0,
    );
  const showExplicitHitOriginal = standardPrice?.input.explicitCacheHit != null
    && isPromotionalDiscount(
      price.rateType,
      standardPrice.input.explicitCacheHit,
      price.inputCacheHit ?? 0,
    );
  const showOutputOriginal = standardPrice != null
    && isPromotionalDiscount(price.rateType, standardPrice.output, price.output);

  return (
    <ModelsServiceTabContentView>
      {isAggregate ? (
        <ModelsServiceInfoBannerView icon={<IconInfoCircle />}>{t("聚合模型按当前已启用路由中的最高成本展示，避免低估调用成本。")}</ModelsServiceInfoBannerView>
      ) : null}
      <ModelsServiceSectionView title={t("官方价格")}>
        {showDetailedStrategy ? (
          <>
            <div className={styles.pricingStrategyMeta}>
              <span>{hasInputLengthTiers(strategyRows) ? t("按输入长度分段计价") : t("当前价格")}</span>
              <strong>{price.currency} / {unitLabel}</strong>
            </div>
            <PricingStrategyCards rows={strategyRows} t={t} />
            {upcomingStrategyRows.length > 0 ? (
              <div className={styles.upcomingPricing}>
                <div className={styles.pricingStrategyMeta}>
                  <span>{t("即将生效 · {time}", {
                    time: formatFullTimestamp(upcomingPrices[0].effectiveFrom ?? "", language),
                  })}</span>
                  <strong>{price.currency} / {unitLabel}</strong>
                </div>
                <PricingStrategyCards rows={upcomingStrategyRows} t={t} />
              </div>
            ) : null}
          </>
        ) : (
          <>
          <div className={styles.configRow}>
          <span>{t("输入定价")}</span>
          <strong className={styles.priceCell}>
            {showInputOriginal ? <span className={styles.priceOriginal}>{formatPrice(standardPrice.input.standard, price.currency)}</span> : null}
            <span>{formatPrice(price.inputUncached, price.currency)} / {unitLabel}</span>
          </strong>
        </div>
        {price.inputCached != null ? (
          <div className={styles.configRow}>
            <span>{t("缓存命中")}</span>
            <strong className={styles.priceCell}>
              {showCachedOriginal && standardPrice?.input.cacheHit != null
                ? <span className={styles.priceOriginal}>{formatPrice(standardPrice.input.cacheHit, price.currency)}</span>
                : null}
              <span>{formatPrice(price.inputCached, price.currency)} / {unitLabel}</span>
            </strong>
          </div>
        ) : null}
        {price.inputCacheWrite != null ? (
          <div className={styles.configRow}>
            <span>{t("缓存写入")}</span>
            <strong className={styles.priceCell}>
              {showCacheWriteOriginal && standardPrice?.input.explicitCacheCreation != null
                ? <span className={styles.priceOriginal}>{formatPrice(standardPrice.input.explicitCacheCreation, price.currency)}</span>
                : null}
              <span>{formatPrice(price.inputCacheWrite, price.currency)} / {unitLabel}</span>
            </strong>
          </div>
        ) : null}
        {price.inputCacheHit != null ? (
          <div className={styles.configRow}>
            <span>{t("显式命中")}</span>
            <strong className={styles.priceCell}>
              {showExplicitHitOriginal && standardPrice?.input.explicitCacheHit != null
                ? <span className={styles.priceOriginal}>{formatPrice(standardPrice.input.explicitCacheHit, price.currency)}</span>
                : null}
              <span>{formatPrice(price.inputCacheHit, price.currency)} / {unitLabel}</span>
            </strong>
          </div>
        ) : null}
        <div className={styles.configRow}>
          <span>{t("输出定价")}</span>
          <strong className={styles.priceCell}>
            {showOutputOriginal ? <span className={styles.priceOriginal}>{formatPrice(standardPrice.output, price.currency)}</span> : null}
            <span>{formatPrice(price.output, price.currency)} / {unitLabel}</span>
          </strong>
        </div>
          </>
        )}
      </ModelsServiceSectionView>
      <div className={styles.priceSourceRow}>
        <span>{price.retrievedAt ? t("更新于 {time}", { time: formatFullTimestamp(price.retrievedAt, language) }) : null}</span>
        {price.sourceUrl ? <a href={price.sourceUrl} target="_blank" rel="noreferrer">{t("价格来源")}</a> : null}
      </div>
      {resolved?.supplementedFromModelsDev ? (
        <div className={styles.infoFootnote}>
          <span>{t("部分字段由 models.dev 补全")}</span>
          {resolved.modelsDevReferenceUrl ? <a href={resolved.modelsDevReferenceUrl} target="_blank" rel="noreferrer">{t("参考链接")}</a> : null}
        </div>
      ) : null}
    </ModelsServiceTabContentView>
  );
}
