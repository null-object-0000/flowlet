import { useEffect, useMemo, useState } from "react";
import { Button, Input, Modal, Select, Switch, Tabs, Typography } from "@douyinfe/semi-ui-19";
import { IconHandle, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useAccounts, useChannelPresets } from "../../features/channel-accounts";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useChannelModels, useModelPrices, useRouteCandidates } from "../../features/exposed-models/useModels";
import { buildModelServiceItems, type ModelRouteGroup, type ModelServiceItem } from "./modelServiceView";
import { buildModelBasicInfo, type ModelBasicInfo } from "./modelBasicInfo";
import { buildChannelFilterOptions, filterModelServiceItems, reorderModelRouteGroups, type ModelStatusFilter } from "./modelServiceInteractions";
import type { ChannelModel } from "../../domains/model/types";
import type { ModelPriceInfo } from "../../domains/settings/types";
import { formatCompactNumber, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostAmount } from "../../shared/formatters/cost";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";
import {
  useLocalModelsCnCatalog,
  resolveChannelModel,
  parseCatalogJson,
  aggregateMinLimits,
  aggregateCapabilitiesIntersection,
  aggregateMaxPrice,
  aggregateMaxStandardPrice,
  buildPricingStrategyRows,
  isPromotionalDiscount,
} from "../../domains/modelCatalog";
import type { ModelsCnPrice, PricingStrategyRow, ResolvedModel, ResolvedPrice } from "../../domains/modelCatalog";
import { useModelCatalogsSync } from "../../features/background-tasks/useBackgroundTasks";
import { channelCommands, type PresetSyncPreview } from "../../domains/channel/commands";
import styles from "./ModelServicesPage.module.css";

const { Paragraph, Text, Title } = Typography;

/** 把聚合模型 helper 产出的 ResolvedPrice（扁平 input* 字段）转回 ModelsCnPrice 形态，
 *  方便 UI 统一按 input.standard / input.cacheHit 访问。sourceUrl 仅作兜底。 */
function priceFromResolvedStandard(p: ResolvedPrice): ModelsCnPrice {
  return {
    market: p.market,
    currency: p.currency,
    unit: p.unit,
    rateType: "standard",
    input: {
      standard: p.inputUncached,
      cacheHit: p.inputCached ?? undefined,
      explicitCacheCreation: p.inputCacheWrite ?? undefined,
    },
    output: p.output,
    sourceUrl: p.sourceUrl,
  };
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

  return (
    <div className={styles.pricingTierList}>
      {rows.map((row) => (
        <section className={styles.pricingTier} key={row.key}>
          <header>
            <strong>{row.inputTokenRange?.label ?? t("全部输入")}</strong>
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
  const channelModels = useChannelModels();
  // 定价仅用于详情展示，加载失败降级为“—”，不参与页面级 loading/error 聚合。
  const prices = useModelPrices();
  // models-cn 目录：只读本地（由后台定时任务拉取）。本地无数据时 catalog 为 null。
  const catalogEntry = useLocalModelsCnCatalog();
  const syncModelCatalogs = useModelCatalogsSync();
  const actions = useModelActions();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<ModelStatusFilter>("all");
  const [channelFilter, setChannelFilter] = useState("all");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const models = useMemo(
    () => buildModelServiceItems(routes.data ?? [], accounts.data ?? [], channels.data ?? []),
    [accounts.data, channels.data, routes.data],
  );
  const filtered = useMemo(
    () => filterModelServiceItems(models, search, status, channelFilter),
    [channelFilter, models, search, status],
  );

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
      : undefined;
  const enabledCount = models.filter((model) => model.enabled).length;
  const availableCount = models.filter((model) => model.available).length;
  const loading = accounts.isLoading || channels.isLoading || routes.isLoading || channelModels.isLoading;
  const error = accounts.error ?? channels.error ?? routes.error ?? channelModels.error;

  const [syncPreview, setSyncPreview] = useState<PresetSyncPreview | null>(null);
  const [syncPending, setSyncPending] = useState(false);
  const [syncApplying, setSyncApplying] = useState(false);

  const refresh = () => void Promise.all([accounts.refetch(), routes.refetch(), channelModels.refetch(), prices.refetch(), catalogEntry.refetch()]);
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

  return (
    <main className={styles.page}>
      <header className={styles.pageHeading}>
        <div><Title heading={3}>{t("模型服务")}</Title><Paragraph>{t("管理对外模型名称、渠道路由与可用状态")}</Paragraph></div>
        <Button className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`} type="tertiary" theme="outline" icon={<IconRefresh />} onClick={openSyncPresets} loading={syncPending}>{t("刷新模型")}</Button>
      </header>

      <section className={styles.stats} aria-label={t("模型服务统计")}>
        <Stat label={t("对外模型")} value={models.length} />
        <Stat label={t("已启用")} value={enabledCount} tone="success" />
        <Stat label={t("当前可用")} value={availableCount} />
        <Stat label={t("渠道模型")} value={channelModels.data?.length ?? 0} />
      </section>

      {error ? <div className={styles.state}><strong>{t("模型服务加载失败")}</strong><span>{error.message}</span><Button onClick={refresh}>{t("重试")}</Button></div> : null}
      {!error ? <div className={styles.workspace}>
        <section className={styles.listCard}>
          <div className={styles.toolbar}>
            <Input prefix={<IconSearch />} value={search} onChange={setSearch} placeholder={t("搜索模型名称或映射模型")} aria-label={t("搜索模型")} />
            <Select
              value={channelFilter}
              aria-label={t("渠道类型")}
              optionList={[
                { value: "all", label: t("全部渠道") },
                ...buildChannelFilterOptions(models, channels.data ?? []),
              ]}
              onChange={(value) => setChannelFilter(String(value))}
            />
            <Select
              value={status}
              aria-label={t("模型状态")}
              optionList={[
                { value: "all", label: t("全部状态") },
                { value: "enabled", label: t("已启用") },
                { value: "disabled", label: t("已停用") },
              ]}
              onChange={(value) => setStatus(value as ModelStatusFilter)}
            />
          </div>
          <div className={styles.listHead}><span>{t("对外模型")}</span><span>{t("可用路由")}</span><span>{t("状态")}</span><span>{t("启用")}</span></div>
          <div className={styles.modelList}>
            {loading ? <div className={styles.empty}>{t("正在加载模型…")}</div> : null}
            {!loading && filtered.length === 0 ? <div className={styles.empty}>{models.length ? t("没有匹配的模型") : t("暂无模型，请先添加渠道账号")}</div> : null}
            {filtered.map((model) => <div
              role="button"
              tabIndex={0}
              key={model.publicModel}
              className={`${styles.modelRow} ${selectedModel === model.publicModel ? styles.selected : ""}`}
              onClick={() => setSelectedModel(model.publicModel)}
              onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedModel(model.publicModel); }}
            >
              <span className={styles.modelName}><ModelLogo model={model} /><span><strong>{model.publicModel}</strong><small>{model.kind === "aggregate" ? t("Flowlet 聚合模型") : model.channelName ?? model.channelId}</small></span></span>
              <span>{t("{count} 条", { count: model.routeGroups.filter((route) => route.enabled).length })}</span>
              <span className={model.available ? styles.healthy : styles.unavailable}>{t(model.available ? "可用" : "不可用")}</span>
              <span onClick={(event) => event.stopPropagation()}><Switch
                checked={model.enabled}
                loading={busyModel === model.publicModel}
                disabled={busyModel != null || model.routeIds.length === 0}
                aria-label={t("{model} 对外开放", { model: model.publicModel })}
                onChange={(checked) => toggleModel(model, checked)}
              /></span>
            </div>)}
          </div>
          <footer className={styles.listFooter}><span>{t("共 {count} 个模型", { count: filtered.length })}</span><span>{t("点击模型查看路由配置")}</span></footer>
        </section>

        <ModelDetail
          model={selected}
          accounts={accounts.data ?? []}
          channels={channels.data ?? []}
          channelModels={channelModels.data ?? []}
          prices={prices.data ?? []}
          catalogJson={catalogEntry.data ?? null}
          catalogLoading={catalogEntry.isLoading}
          syncCatalogsPending={syncModelCatalogs.isPending}
          onSyncCatalogs={syncCatalogs}
          language={language}
          busy={busyModel != null}
          onToggleRoute={toggleRoute}
          onReorderRoute={reorderRoute}
          t={t}
        />
      </div> : null}

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
                  {t("以下渠道新增暴露模型（同步后自动生成路由）：")}
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

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" }) {
  return <div className={styles.stat}><span>{label}</span><strong className={tone === "success" ? styles.successValue : ""}>{value}</strong></div>;
}

function ModelLogo({ model }: { model: ModelServiceItem }) {
  if (model.kind === "direct") return <ChannelBrandLogo channelId={model.channelId ?? "flowlet"} name={model.channelName ?? model.publicModel} />;
  return <FlowletLogo variant="model" />;
}

function ModelDetail({ model, accounts, channels, channelModels, prices, catalogJson, catalogLoading, syncCatalogsPending, onSyncCatalogs, language, busy, onToggleRoute, onReorderRoute, t }: {
  model: ModelServiceItem | null;
  accounts: ReturnType<typeof useAccounts>["data"] extends (infer T)[] | undefined ? T[] : never;
  channels: ReturnType<typeof useChannelPresets>["data"] extends (infer T)[] | undefined ? T[] : never;
  channelModels: ChannelModel[];
  prices: ModelPriceInfo[];
  catalogJson: string | null;
  catalogLoading: boolean;
  syncCatalogsPending: boolean;
  onSyncCatalogs: () => void;
  language: NumberLanguage;
  busy: boolean;
  onToggleRoute: (modelId: string, routeGroup: ModelRouteGroup, enabled: boolean) => void;
  onReorderRoute: (modelId: string, sourceKey: string, targetKey: string) => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const [draggedRouteKey, setDraggedRouteKey] = useState<string | null>(null);
  const [dragTargetKey, setDragTargetKey] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState("basic");
  useEffect(() => {
    const cancelPointerDrag = () => {
      setDraggedRouteKey(null);
      setDragTargetKey(null);
    };
    window.addEventListener("pointercancel", cancelPointerDrag);
    window.addEventListener("pointerup", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointercancel", cancelPointerDrag);
      window.removeEventListener("pointerup", cancelPointerDrag);
    };
  }, []);

  // 解析本地 models-cn.json 文件内容。必须放在所有提前返回之前，
  // 保证每次渲染 hook 调用顺序一致（Rules of Hooks）。
  const catalog = useMemo(() => (catalogJson ? parseCatalogJson(catalogJson) : null), [catalogJson]);

  // 直接渠道模型的 models-cn 官方数据。
  const directResolved: ResolvedModel | null = useMemo(() => {
    if (!model || model.kind !== "direct" || !catalog) return null;
    const channelId = model.channelId ?? model.routeGroups[0]?.channelId;
    const upstream = model.routeGroups[0]?.upstreamModel ?? model.publicModel;
    if (!channelId) return null;
    return resolveChannelModel(catalog, channelId, upstream);
  }, [catalog, model]);

  // 聚合模型（flowlet-pro/flowlet-flash）：汇总旗下所有已启用子路由的 limits/caps/prices。
  // limits 取最小值（木桶效应）、caps 取交集（只承诺所有子模型都支持的能力）、
  // prices 取最大值（展示最坏情况下的成本上限）。
  const aggregateResolved: ResolvedModel | null = useMemo(() => {
    if (!model || model.kind !== "aggregate" || !catalog) return null;
    const subModels: ResolvedModel[] = [];
    for (const route of model.routeGroups) {
      const resolved = resolveChannelModel(catalog, route.channelId, route.upstreamModel);
      if (resolved) subModels.push(resolved);
    }
    if (subModels.length === 0) return null;
    const officialPrice = aggregateMaxPrice(subModels);
    const limits = aggregateMinLimits(subModels);
    const capabilities = aggregateCapabilitiesIntersection(subModels);
    return {
      providerId: "flowlet",
      providerName: "Flowlet",
      modelId: model.publicModel,
      modelName: model.publicModel,
      limits,
      capabilities,
      aliases: [],
      officialPrice,
      allPrices: [],
      supplementedFromModelsDev: false,
      modelsDevReferenceUrl: null,
    };
  }, [catalog, model]);

  // 当前模型实际使用的 resolved 数据源。
  const resolved = model?.kind === "aggregate" ? aggregateResolved : directResolved;

  // 聚合模型的划价展示：用旗下子模型的 standard 价格取最大值，与当前（promotional）对比。
  const aggregateStandardPrice = useMemo(() => {
    if (!model || model.kind !== "aggregate" || !catalog || !resolved?.officialPrice) return null;
    const subModels: ResolvedModel[] = [];
    for (const route of model.routeGroups) {
      const resolvedSub = resolveChannelModel(catalog, route.channelId, route.upstreamModel);
      if (resolvedSub) subModels.push(resolvedSub);
    }
    if (subModels.length === 0) return null;
    return aggregateMaxStandardPrice(subModels);
  }, [catalog, model, resolved?.officialPrice]);

  // 基础信息：优先 models-cn 官方值，缺失降级到渠道同步。
  const basicInfo: ModelBasicInfo | null = useMemo(
    () => (model ? buildModelBasicInfo(model, channelModels, prices) : null),
    [model, channelModels, prices],
  );

  if (!model) return <section className={`${styles.detailCard} ${styles.detailEmpty}`}><Text type="tertiary">{t("选择一个模型查看路由配置")}</Text></section>;

  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const canReorder = !busy && model.routeGroups.length > 1;

  // 聚合模型（flowlet-pro/flowlet-flash）没有厂商官方价格，不展示"立即同步"。
  const showPricingSync = model.kind === "direct";

  return <section className={styles.detailCard}>
    <header className={styles.detailHeader}><ModelLogo model={model} /><span><strong>{model.publicModel}</strong><small>{model.availableAccountCount > 0 ? t("{count} 个可用账号", { count: model.availableAccountCount }) : t("无可用账号")}</small></span></header>
    <div className={styles.detailBody}>
      <Tabs className={styles.detailTabs} type="line" activeKey={activeTab} onChange={(key) => setActiveTab(String(key))} tabPaneMotion={false}>
        <Tabs.TabPane tab={t("基础信息")} itemKey="basic">
          <ModelBasicInfoTab basicInfo={basicInfo} resolved={resolved} isAggregate={model.kind === "aggregate"} language={language} t={t} />
        </Tabs.TabPane>
        <Tabs.TabPane tab={t("价格信息")} itemKey="pricing">
          <ModelPricingTab
            resolved={resolved}
            standardPrice={model.kind === "direct" ? undefined : aggregateStandardPrice}
            hasCatalog={catalog !== null}
            catalogLoading={catalogLoading}
            showSyncButton={showPricingSync}
            isAggregate={model.kind === "aggregate"}
            syncPending={syncCatalogsPending}
            onSync={onSyncCatalogs}
            language={language}
            t={t}
          />
        </Tabs.TabPane>
        <Tabs.TabPane tab={t("渠道路由")} itemKey="routing" className={styles.routingTab}>
          <DetailSection title={t("渠道路由")} note={t("拖动路由可调整优先级")}>
              {model.routeGroups.map((routeGroup, index) => {
                const account = accountById.get(routeGroup.accountId);
                const usable = Boolean(account?.enabled && account.api_key.trim() && account.credential_status !== "invalid_key");
                const moveByKeyboard = (direction: -1 | 1) => {
                  const target = model.routeGroups[index + direction];
                  if (target) onReorderRoute(model.publicModel, routeGroup.key, target.key);
                };
                return <div
                  className={`${styles.routeRow} ${draggedRouteKey === routeGroup.key ? styles.dragging : ""} ${dragTargetKey === routeGroup.key ? styles.dragTarget : ""}`}
                  key={routeGroup.key}
                  onPointerEnter={() => {
                    if (canReorder && draggedRouteKey && draggedRouteKey !== routeGroup.key) setDragTargetKey(routeGroup.key);
                  }}
                  onPointerUp={() => {
                    const sourceKey = draggedRouteKey;
                    setDraggedRouteKey(null);
                    setDragTargetKey(null);
                    if (canReorder && sourceKey && sourceKey !== routeGroup.key) {
                      onReorderRoute(model.publicModel, sourceKey, routeGroup.key);
                    }
                  }}
                >
                  <button
                    type="button"
                    className={`${styles.dragHandle} ${!canReorder ? styles.dragHandleInactive : ""}`}
                    disabled={busy}
                    aria-disabled={!canReorder}
                    aria-label={t("拖动调整路由 {name} 的优先级", { name: routeGroup.upstreamModel })}
                    title={model.routeGroups.length > 1 ? t("拖动调整优先级") : t("当前只有一条路由，无需排序")}
                    onPointerDown={(event) => {
                      if (!canReorder || event.button !== 0) return;
                      event.preventDefault();
                      setDraggedRouteKey(routeGroup.key);
                      setDragTargetKey(null);
                    }}
                    onKeyDown={(event) => {
                      if (!canReorder) return;
                      if (event.key === "ArrowUp") {
                        event.preventDefault();
                        moveByKeyboard(-1);
                      } else if (event.key === "ArrowDown") {
                        event.preventDefault();
                        moveByKeyboard(1);
                      }
                    }}
                  ><IconHandle /></button>
                  <span className={styles.priority}>{index + 1}</span>
                  <span className={styles.routeCopy}><strong>{channelById.get(routeGroup.channelId)?.name ?? routeGroup.channelId} · {account?.name ?? routeGroup.accountId}</strong><small>{routeGroup.upstreamModel}</small></span>
                  <span className={usable ? styles.healthy : styles.unavailable}>{t(usable ? "可用" : "不可用")}</span>
                  <Switch checked={routeGroup.enabled} disabled={busy} aria-label={t("启用路由 {name}", { name: routeGroup.upstreamModel })} onChange={(checked) => onToggleRoute(model.publicModel, routeGroup, checked)} />
                </div>;
              })}
            </DetailSection>
        </Tabs.TabPane>
      </Tabs>
    </div>
    <footer className={styles.detailFooter}>{t("配置变更会立即保存并热更新到本地代理")}</footer>
  </section>;
}

function DetailSection({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className={styles.detailSection}><header><strong>{title}</strong>{note ? <span>{note}</span> : null}</header><div className={styles.configBox}>{children}</div></section>;
}

/** 基础信息 Tab：上下文窗口、最大输出、能力。优先展示 models-cn 官方值。
 *  聚合模型（flowlet-pro/flowlet-flash）：limits 取旗下子模型最小值（木桶效应），
 *  capabilities 取交集（只承诺所有子模型都支持的能力）。 */
function ModelBasicInfoTab({ basicInfo, resolved, isAggregate, language, t }: {
  basicInfo: ModelBasicInfo | null;
  resolved: ResolvedModel | null;
  isAggregate: boolean;
  language: NumberLanguage;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  // 聚合模型不参与 basicInfo（仅 direct 使用）。
  const contextTokens = resolved?.limits.contextTokens ?? (isAggregate ? null : basicInfo?.contextWindow) ?? null;
  const maxOutputTokens = resolved?.limits.maxOutputTokens ?? (isAggregate ? null : basicInfo?.maxOutputTokens) ?? null;
  const caps = resolved?.capabilities;
  return (
    <div className={styles.tabContent}>
      {isAggregate ? (
        <div className={styles.infoFootnote}>{t("聚合模型参数取旗下已启用子模型的最小值（木桶效应）。")}</div>
      ) : null}
      <DetailSection title={t("模型参数")}>
        <div className={styles.configRow}><span>{t("上下文窗口")}</span><strong>{formatCompactNumber(contextTokens, language)}</strong></div>
        <div className={styles.configRow}><span>{t("最大输出")}</span><strong>{formatCompactNumber(maxOutputTokens, language)}</strong></div>
      </DetailSection>
      {caps ? (
        <DetailSection title={t("模型能力")}>
          {isAggregate ? <div className={styles.infoFootnote}>{t("仅展示所有子模型都支持的能力。")}</div> : null}
          <div className={styles.configRow}><span>{t("推理")}</span><strong>{caps.thinking ? t("支持") : t("不支持")}</strong></div>
          <div className={styles.configRow}><span>{t("工具调用")}</span><strong>{caps.toolCalls ? t("支持") : t("不支持")}</strong></div>
          <div className={styles.configRow}><span>{t("JSON 输出")}</span><strong>{caps.jsonOutput ? t("支持") : t("不支持")}</strong></div>
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
    </div>
  );
}

/** 价格信息 Tab：展示 models-cn 官方价格（与渠道账号无关的厂商直销价）。
 *  数据完全来自 models-cn，不再有 config.json 降级。
 *  聚合模型（flowlet-pro/flowlet-flash）：价格取旗下子模型的最大值（展示最坏情况
 *  下的成本上限），standard 价格也取最大值用于划价展示。 */
function ModelPricingTab({ resolved, standardPrice: standardPriceOverride, hasCatalog, catalogLoading, showSyncButton, isAggregate, syncPending, onSync, language, t }: {
  resolved: ResolvedModel | null;
  standardPrice?: ResolvedPrice | null;
  hasCatalog: boolean;
  catalogLoading: boolean;
  showSyncButton: boolean;
  isAggregate: boolean;
  syncPending: boolean;
  onSync: () => void;
  language: NumberLanguage;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const price = resolved?.officialPrice;
  const unitLabel = price && price.unit !== "1M_tokens" ? price.unit : t("百万 tokens");
  const formatPrice = (amount: number, currency: string) => formatCostAmount({ amount, currency }, 2);

  if (!price) {
    return (
      <div className={styles.tabContent}>
        {hasCatalog || !showSyncButton ? (
          <div className={styles.empty}>{t("暂无官方价格数据")}</div>
        ) : (
          <div className={styles.empty}>
            <span>{catalogLoading ? t("正在加载 models-cn 数据…") : t("本地暂无 models-cn 数据，后台定时任务将自动拉取。")}</span>
            <Button theme="borderless" type="tertiary" size="small" onClick={onSync} loading={syncPending}>{t("立即同步")}</Button>
          </div>
        )}
      </div>
    );
  }

  // 划价展示用的 standard 价格：聚合模型用外部传入（子模型 standard 最大值），
  // 直接模型从 allPrices 中取同市场同币种的 standard。统一按 ModelsCnPrice 形态
  // 处理，便于直接访问 input.standard / input.cacheHit。
  const standardPrice: ModelsCnPrice | null = standardPriceOverride
    ? priceFromResolvedStandard(standardPriceOverride)
    : (resolved?.allPrices ?? []).find((p) => p.market === price.market && p.currency === price.currency && p.rateType === "standard") ?? null;
  const strategyRows = !isAggregate
    ? buildPricingStrategyRows(resolved?.allPrices ?? [], price.market, price.currency)
    : [];
  const showDetailedStrategy = strategyRows.length > 1 || strategyRows.some((row) => (
    row.inputTokenRange != null
    || row.current.input.explicitCacheCreation != null
    || row.current.input.explicitCacheHit != null
    || row.standard?.input.explicitCacheCreation != null
    || row.standard?.input.explicitCacheHit != null
  ));
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
  const showOutputOriginal = standardPrice != null
    && isPromotionalDiscount(price.rateType, standardPrice.output, price.output);

  return (
    <div className={styles.tabContent}>
      {isAggregate ? <div className={styles.infoFootnote}>{t("聚合模型价格取旗下已启用子模型的最大值（成本上限）。")}</div> : null}
      <DetailSection title={t("官方价格")}>
        {showDetailedStrategy ? (
          <>
            <div className={styles.pricingStrategyMeta}>
              <span>{t("按输入长度分段计价")}</span>
              <strong>{price.currency} / {unitLabel}</strong>
            </div>
            <PricingStrategyCards rows={strategyRows} t={t} />
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
        <div className={styles.configRow}>
          <span>{t("输出定价")}</span>
          <strong className={styles.priceCell}>
            {showOutputOriginal ? <span className={styles.priceOriginal}>{formatPrice(standardPrice.output, price.currency)}</span> : null}
            <span>{formatPrice(price.output, price.currency)} / {unitLabel}</span>
          </strong>
        </div>
          </>
        )}
      </DetailSection>
      <div className={styles.infoFootnote}>
        {price.retrievedAt ? <span>{t("抓取时间")}: {formatFullTimestamp(price.retrievedAt, language)}</span> : null}
        {price.sourceUrl ? <a href={price.sourceUrl} target="_blank" rel="noreferrer">{t("价格来源")}</a> : null}
      </div>
      {resolved?.supplementedFromModelsDev ? (
        <div className={styles.infoFootnote}>
          <span>{t("部分字段由 models.dev 补全")}</span>
          {resolved.modelsDevReferenceUrl ? <a href={resolved.modelsDevReferenceUrl} target="_blank" rel="noreferrer">{t("参考链接")}</a> : null}
        </div>
      ) : null}
    </div>
  );
}
