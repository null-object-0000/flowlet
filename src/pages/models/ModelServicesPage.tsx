import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Button, Modal, Toast } from "@douyinfe/semi-ui-19";
import { IconCopy, IconInfoCircle } from "@douyinfe/semi-icons";
import { ModelsServiceCapabilityListView, ModelsServiceDetailView, ModelsServiceInfoBannerView, ModelsServiceMetricGridView, ModelsServiceRefreshActionView, ModelsServiceRouteOverviewView, ModelsServiceSectionView, ModelsServiceTabContentView, ModelsServiceToolbarView, ModelsServiceView, type ModelsServiceItemModel, type ModelsServiceRouteModel } from "@flowlet/product-ui";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useAccounts, useChannelPresets } from "../../features/channel-accounts";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useRouteCandidates } from "../../features/exposed-models/useModels";
import { PageHeader } from "../../shared/ui/PageHeader";
import { copyText } from "../../shared/ui/copyText";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import {
  buildModelServiceItems,
  type ModelRouteGroup,
  type ModelServiceItem,
} from "./modelServiceView";
import {
  buildChannelFilterOptions,
  filterModelServiceItems,
  removeModelRouteGroup,
  reorderModelRouteGroups,
} from "./modelServiceInteractions";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { formatTokenCapacity, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostAmount } from "../../shared/formatters/cost";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import {
  useLocalModelsCnCatalog,
  useLocalModelsDevCatalog,
  resolveModelSpecification,
  parseCatalogJson,
  parseModelsDevCatalogJson,
  buildPricingStrategyRows,
  effectiveWindowPricesAt,
  groupDailyTimeRangeIntervals,
  hasInputLengthTiers,
  isPromotionalDiscount,
  MODEL_CN_DAY_ORDER,
  nextEffectivePricesAt,
  officialOwnerNameForModel,
  weekdayRunGroups,
} from "../../domains/modelCatalog";
import type { ModelsCnDailyTimeRangeInterval, ModelsCnDayOfWeek, ModelsCnPrice, PricingStrategyRow, ResolvedModel } from "../../domains/modelCatalog";
import { useModelCatalogsSync } from "../../features/background-tasks/useBackgroundTasks";
import { channelCommands, type PresetSyncPreview } from "../../domains/channel/commands";
import styles from "./ModelServicesPage.module.css";

/** 单条区间的时间段文本：整日区间显示「全天」，end=00:00 按次日午夜显示 24:00。 */
function formatTimeInterval(interval: ModelsCnDailyTimeRangeInterval): string {
  if (interval.start === "00:00" && interval.end === "00:00") return "全天";
  return `${interval.start}–${interval.end === "00:00" ? "24:00" : interval.end}`;
}

const DAY_LABELS: Record<ModelsCnDayOfWeek, string> = {
  mon: "周一",
  tue: "周二",
  wed: "周三",
  thu: "周四",
  fri: "周五",
  sat: "周六",
  sun: "周日",
};

/** 把星期压缩为「周一至周五」这类标签；0 天或 7 天（每天）返回空串。 */
function weekdaysLabel(days: readonly ModelsCnDayOfWeek[]): string {
  if (days.length === 0 || days.length === MODEL_CN_DAY_ORDER.length) return "";
  return weekdayRunGroups(days)
    .map((run) => {
      const first = run[0]!;
      const lastOfRun = run[run.length - 1]!;
      return run.length === 1
        ? DAY_LABELS[first]
        : `${DAY_LABELS[first]}至${DAY_LABELS[lastOfRun]}`;
    })
    .join("、");
}

function formatDailyPriceRange(price: ModelsCnPrice, t: (source: string) => string): string | null {
  const range = price.dailyTimeRange;
  if (!range) return null;
  const zone = range.timeZone === "Asia/Shanghai" ? t("北京时间") : range.timeZone;
  const hasDayRestrictions = range.intervals.some((interval) => (interval.days?.length ?? 0) > 0);
  const parts = groupDailyTimeRangeIntervals(range).map(({ days, intervals }) => {
    const rawLabel = days.length === 0 ? t("每天") : weekdaysLabel(days);
    const label = hasDayRestrictions && rawLabel ? `${rawLabel} ` : "";
    return `${label}${intervals.map(formatTimeInterval).join(t("、"))}`;
  });
  return `${range.label} · ${zone} ${parts.join(t("；"))}`;
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
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [channelFilter, setChannelFilter] = useState("all");
  // 支持从概览页「开放模型」入口跳转并自动选中对应模型（?model=<规范模型 ID>）。
  const [selectedModel, setSelectedModel] = useState<string | null>(() => searchParams.get("model"));

  const models = useMemo(
    () => buildModelServiceItems(routes.data ?? [], accounts.data ?? [], channels.data ?? []),
    [accounts.data, channels.data, routes.data],
  );
  const filtered = useMemo(
    () => filterModelServiceItems(models, search, channelFilter),
    [channelFilter, models, search],
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
      : actions.updateRoutes.isPending
        ? actions.updateRoutes.variables?.modelId
        : undefined;
  const enabledCount = models.filter((model) => model.enabled).length;
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
  const removeRoute = (modelId: string, routeGroup: ModelRouteGroup) => {
    const currentRoutes = routes.data ?? [];
    const nextRoutes = removeModelRouteGroup(currentRoutes, modelId, routeGroup.routeIds);
    if (nextRoutes === currentRoutes) return;
    actions.updateRoutes.mutate({
      routes: currentRoutes,
      nextRoutes,
      modelId,
      message: t("已从 {model} 移除", { model: modelId }),
    });
  };

  const toViewModel = (model: ModelServiceItem): ModelsServiceItemModel => {
    const summary = model.availableAccountCount > 0
      ? t("{count} 个可用账号", { count: model.availableAccountCount })
      : t("无可用账号");
    const typeLabel = t("{channel} · 渠道模型", { channel: model.channelName ?? model.channelId ?? "—" });
    return {
      id: model.publicModel,
      name: model.publicModel,
      typeLabel,
      summary,
      summaryMuted: model.availableAccountCount === 0,
      enabled: model.enabled,
      logo: <ModelLogo model={model} />,
      toggleLabel: t("{model} 对外开放", { model: model.publicModel }),
      toggleLoading: busyModel === model.publicModel,
      toggleDisabled: busyModel != null || model.routeIds.length === 0,
    };
  };
  const viewModels = filtered.map(toViewModel);

  return (
    <main className={styles.page}>
      <PageHeader title={t("模型服务")} subtitle={t("管理对外模型、渠道能力与请求路由")}>
        <ModelsServiceRefreshActionView label={t("刷新模型")} onClick={import.meta.env.MODE === "web" ? refresh : openSyncPresets} loading={syncPending} />
      </PageHeader>

      {error ? <div className={styles.state}><strong>{t("模型服务加载失败")}</strong><span>{error.message}</span><Button onClick={refresh}>{t("重试")}</Button></div> : null}
      {!error ? <ModelsServiceView
        stats={[
          { key: "models", label: t("对外模型"), value: String(models.length) },
          { key: "enabled", label: t("已启用"), value: String(enabledCount), tone: "success" },
          { key: "channels", label: t("已接入渠道"), value: String(connectedChannelCount) },
        ]}
        models={viewModels}
        labels={{
          stats: {},
          statsAria: t("模型服务统计"),
          currentVisible: t("当前显示 {visible} / 共 {total} 个模型", { visible: filtered.length, total: models.length }),
          hint: t("选择模型后在右侧查看详情"),
          ready: t("可用"),
          off: t("关闭"),
          empty: loading ? t("正在加载模型…") : (models.length ? t("没有匹配的模型") : t("暂无模型，请先添加渠道账号")),
        }}
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
          accounts={accounts.data ?? []}
          channels={channels.data ?? []}
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
          onRemoveRoute={removeRoute}
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
  return <ChannelBrandLogo channelId={model.channelId ?? "flowlet"} name={model.channelName ?? model.publicModel} />;
}

function ModelDetail({ model, accounts, channels, catalogJson, modelsDevCatalogJson, catalogLoading, modelsDevCatalogLoading, syncCatalogsPending, onSyncCatalogs, language, pendingModel, onToggleRoute, onReorderRoute, onRemoveRoute, t }: {
  model: ModelServiceItem | null;
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
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
  onRemoveRoute: (modelId: string, routeGroup: ModelRouteGroup) => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
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

  // 模型规格按路由候选的 (渠道, 上游模型) 从 models-cn → models.dev 回退解析。
  const resolved: ResolvedModel | null = useMemo(() => {
    if (!model) return null;
    for (const route of model.routeGroups) {
      const resolvedModel = resolveModelSpecification(
        catalog,
        modelsDevCatalog,
        route.channelId,
        route.upstreamModel,
        pricingNow,
        !catalogLoading && !modelsDevCatalogLoading,
      );
      if (resolvedModel) return resolvedModel;
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

  // 基础信息：优先 models-cn 官方值，缺失降级到渠道同步。
  if (!model) return <ModelsServiceDetailView empty={t("选择一个模型查看路由配置")} />;

  const busy = pendingModel != null;
  const accountLabel = model.availableAccountCount > 0
    ? t("{count} 个可用账号", { count: model.availableAccountCount })
    : t("无可用账号");
  const enabledRouteCount = model.routeGroups.filter((routeGroup) => routeGroup.enabled).length;
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
    if (routeGroup) onRemoveRoute(model.publicModel, routeGroup);
  };

  const copyModelName = async () => {
    try {
      await copyText(model.publicModel);
      Toast.success(t("已复制"));
    } catch {
      Toast.error(t("复制失败"));
    }
  };

  return <ModelsServiceDetailView
    logo={<ModelLogo model={model} />}
    title={model.publicModel}
    subtitle={`${t("渠道模型")} · ${accountLabel}`}
    headerAction={<Button aria-label={t("复制模型名称")} title={t("复制模型名称")} icon={<IconCopy />} theme="borderless" size="small" onClick={() => void copyModelName()} />}
    activeKey={activeTab}
    onTabChange={setActiveTab}
    tabs={[
      { key: "basic", label: t("基础信息"), content: <>
          <ModelBasicInfoTab
            resolved={resolved}
            channelName={model.channelName}
            officialOwnerName={officialOwnerNameForModel(model.publicModel)}
            language={language}
            t={t}
          />
        </> },
      { key: "pricing", label: t("价格信息"), content: <>
          <ModelPricingTab
            resolved={resolved}
            hasCatalog={catalog !== null}
            catalogLoading={catalogLoading}
            showSyncButton
            syncPending={syncCatalogsPending}
            onSync={onSyncCatalogs}
            at={pricingNow}
            language={language}
            t={t}
          />
        </> },
      { key: "routing", label: t("渠道路由"), content: <>
          <ModelsServiceTabContentView>
            <ModelsServiceRouteOverviewView
              title={t("渠道路由")}
              summary={t("{enabled} / {total} 条已启用", { enabled: enabledRouteCount, total: model.routeGroups.length })}
              description={t("同一模型的多个渠道候选按这里的顺序尝试；可单独启停、拖动排序或删除不再使用的候选。")}
              routes={routeViewModels}
              busy={busy}
              removable
              empty={t("尚无路由候选。请先在渠道账号中勾选并保存要开放的模型。")}
              onToggle={toggleViewRoute}
              onReorder={(sourceKey, targetKey) => onReorderRoute(model.publicModel, sourceKey, targetKey)}
              onRemove={removeViewRoute}
            />
          </ModelsServiceTabContentView>
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
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (resolved?.specificationSource === "models-cn") return "models-cn";
  if (resolved?.specificationSource === "models.dev") return "models.dev";
  return "—";
}

function modelSpecificationDescription(
  resolved: ResolvedModel | null,
  t: (source: string, values?: Record<string, string | number>) => string,
): string {
  if (resolved?.specificationSource === "models-cn") return t("当前展示 models-cn 收录的模型规格。");
  if (resolved?.specificationSource === "models.dev") return t("models-cn 暂未收录，当前展示 models.dev 的模型规格。");
  return t("暂无可用的模型规格。");
}

/** 基础信息 Tab：顶部说明 banner + 2×2 参数网格 + 能力清单。优先展示 models-cn 官方值。 */
function ModelBasicInfoTab({ resolved, channelName, officialOwnerName, language, t }: {
  resolved: ResolvedModel | null;
  channelName?: string;
  officialOwnerName?: string | null;
  language: NumberLanguage;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const contextTokens = resolved?.limits.contextTokens ?? null;
  const maxOutputTokens = resolved?.limits.maxOutputTokens ?? null;
  const caps = resolved?.capabilities;
  return (
    <ModelsServiceTabContentView>
      <ModelsServiceInfoBannerView icon={<IconInfoCircle />}>
        {modelSpecificationDescription(resolved, t)}
      </ModelsServiceInfoBannerView>
      <ModelsServiceSectionView title={t("模型参数")}><ModelsServiceMetricGridView items={[
        { key: "context", label: t("上下文窗口"), value: formatTokenCapacity(contextTokens, language) },
        { key: "output", label: t("最大输出"), value: formatTokenCapacity(maxOutputTokens, language) },
        { key: "owner", label: t("官方归属"), value: officialOwnerName ?? resolved?.providerName ?? channelName ?? "—" },
        { key: "source", label: t("规格来源"), value: modelSpecificationSourceLabel(resolved, t) },
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
 *  数据完全来自 models-cn，不再有 config.json 降级。 */
function ModelPricingTab({ resolved, hasCatalog, catalogLoading, showSyncButton, syncPending, onSync, at, language, t }: {
  resolved: ResolvedModel | null;
  hasCatalog: boolean;
  catalogLoading: boolean;
  showSyncButton: boolean;
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

  // 划价展示用的 standard 价格：从 allPrices 中取同市场同币种的 standard。
  const matchingPrices = (resolved?.allPrices ?? []).filter(
    (candidate) => candidate.market === price.market && candidate.currency === price.currency,
  );
  const currentWindowPrices = effectiveWindowPricesAt(matchingPrices, at);
  const upcomingPrices = nextEffectivePricesAt(matchingPrices, at);
  const standardPrice: ModelsCnPrice | null =
    currentWindowPrices.find((candidate) => candidate.rateType === "standard") ?? null;
  const strategyRows = buildPricingStrategyRows(currentWindowPrices, price.market, price.currency);
  const upcomingStrategyRows = upcomingPrices.length > 0
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
