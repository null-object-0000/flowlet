import { useEffect, useMemo, useState } from "react";
import { Button, Input, Select, Switch, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconHandle, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useAccounts, useChannelPresets } from "../../features/channel-accounts";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useChannelModels, useModelPrices, useRouteCandidates } from "../../features/exposed-models/useModels";
import { buildModelServiceItems, type ModelRouteGroup, type ModelServiceItem } from "./modelServiceView";
import { buildModelBasicInfo, type ModelBasicInfo } from "./modelBasicInfo";
import { filterModelServiceItems, reorderModelRouteGroups, type ModelStatusFilter } from "./modelServiceInteractions";
import type { ChannelModel } from "../../domains/model/types";
import type { ModelPriceInfo } from "../../domains/settings/types";
import { formatCompactNumber, type NumberLanguage } from "../../shared/formatters/number";
import { formatCostAmount } from "../../shared/formatters/cost";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";
import styles from "./ModelServicesPage.module.css";

const { Paragraph, Text, Title } = Typography;

export function ModelServicesPage() {
  const { language, t } = useAppPreferences();
  const accounts = useAccounts();
  const channels = useChannelPresets();
  const routes = useRouteCandidates();
  const channelModels = useChannelModels();
  // 定价仅用于详情展示，加载失败降级为“—”，不参与页面级 loading/error 聚合。
  const prices = useModelPrices();
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

  const refresh = () => void Promise.all([accounts.refetch(), channels.refetch(), routes.refetch(), channelModels.refetch(), prices.refetch()]);
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
        <Button className={`${secondaryButtonStyles.button} ${secondaryButtonStyles.compact}`} type="tertiary" theme="outline" icon={<IconRefresh />} onClick={refresh} loading={loading}>{t("刷新模型")}</Button>
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
                ...(channels.data ?? []).map((channel) => ({ value: channel.id, label: channel.name })),
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
          language={language}
          busy={busyModel != null}
          onToggleRoute={toggleRoute}
          onReorderRoute={reorderRoute}
          t={t}
        />
      </div> : null}
    </main>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "success" }) {
  return <div className={styles.stat}><span>{label}</span><strong className={tone === "success" ? styles.successValue : ""}>{value}</strong></div>;
}

function ModelLogo({ model }: { model: ModelServiceItem }) {
  if (model.kind === "direct") return <ChannelBrandLogo channelId={model.channelId ?? "flowlet"} name={model.channelName ?? model.publicModel} />;
  return <FlowletLogo variant="model" />;
}

function ModelDetail({ model, accounts, channels, channelModels, prices, language, busy, onToggleRoute, onReorderRoute, t }: {
  model: ModelServiceItem | null;
  accounts: ReturnType<typeof useAccounts>["data"] extends (infer T)[] | undefined ? T[] : never;
  channels: ReturnType<typeof useChannelPresets>["data"] extends (infer T)[] | undefined ? T[] : never;
  channelModels: ChannelModel[];
  prices: ModelPriceInfo[];
  language: NumberLanguage;
  busy: boolean;
  onToggleRoute: (modelId: string, routeGroup: ModelRouteGroup, enabled: boolean) => void;
  onReorderRoute: (modelId: string, sourceKey: string, targetKey: string) => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const [draggedRouteKey, setDraggedRouteKey] = useState<string | null>(null);
  const [dragTargetKey, setDragTargetKey] = useState<string | null>(null);
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

  if (!model) return <section className={`${styles.detailCard} ${styles.detailEmpty}`}><Text type="tertiary">{t("选择一个模型查看路由配置")}</Text></section>;
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const copy = () => void navigator.clipboard.writeText(model.publicModel);
  const canReorder = !busy && model.routeGroups.length > 1;
  return <section className={styles.detailCard}>
    <header className={styles.detailHeader}><ModelLogo model={model} /><span><strong>{model.publicModel}</strong><small>{model.availableAccountCount > 0 ? t("{count} 个可用账号", { count: model.availableAccountCount }) : t("无可用账号")}</small></span></header>
    <div className={styles.detailBody}>
      <DetailSection title={t("基础配置")}>
        <div className={styles.configRow}><span>{t("对外模型名称")}</span><strong>{model.publicModel}</strong><Button theme="borderless" icon={<IconCopy />} aria-label={t("复制模型名称")} onClick={copy} /></div>
      </DetailSection>
      {model.kind === "direct" ? (
        <DetailSection title={t("基础信息")}>
          <ModelBasicInfoRows info={buildModelBasicInfo(model, channelModels, prices)} language={language} t={t} />
        </DetailSection>
      ) : null}
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
    </div>
    <footer className={styles.detailFooter}>{t("配置变更会立即保存并热更新到本地代理")}</footer>
  </section>;
}

function DetailSection({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return <section className={styles.detailSection}><header><strong>{title}</strong>{note ? <span>{note}</span> : null}</header><div className={styles.configBox}>{children}</div></section>;
}

/** 直接渠道模型的定价与限制展示。聚合模型（flowlet-pro/flash）没有单一
 *  上游，不渲染本区块。数据缺失一律显示“—”，不硬编码限制值（AGENTS.md §7）。 */
function ModelBasicInfoRows({ info, language, t }: {
  info: ModelBasicInfo | null;
  language: NumberLanguage;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  const price = info?.price ?? null;
  const unitLabel = price && price.unit !== "1M tokens" ? price.unit : t("百万 tokens");
  const formatPrice = (amount: number) => (price ? formatCostAmount({ amount, currency: price.currency }, 2) : "—");
  const inputPrice = price ? `${formatPrice(price.input_uncached_price)} / ${unitLabel}` : "—";
  const outputPrice = price ? `${formatPrice(price.output_price)} / ${unitLabel}` : "—";
  const tierBoundary = price && price.tiers.length > 0 ? price.tiers[0].up_to_input_tokens : null;
  const hasTierNote = price != null && price.tiers.length > 0;
  return <>
    <div className={styles.configRow}><span>{t("上下文窗口")}</span><strong>{formatCompactNumber(info?.contextWindow ?? null, language)}</strong></div>
    <div className={styles.configRow}><span>{t("最大输出")}</span><strong>{formatCompactNumber(info?.maxOutputTokens ?? null, language)}</strong></div>
    <div className={styles.configRow}>
      <span>{t("输入定价")}</span>
      <strong className={styles.priceCell}>
        {inputPrice}
        {price && price.input_cached_price !== price.input_uncached_price ? <small>{t("缓存 {price}", { price: formatPrice(price.input_cached_price) })}</small> : null}
        {price?.input_cache_write_price != null ? <small>{t("写入 {price}", { price: formatPrice(price.input_cache_write_price) })}</small> : null}
        {hasTierNote ? <small>{tierBoundary != null ? t("输入超 {tokens} 分段计价", { tokens: formatCompactNumber(tierBoundary, language) }) : t("按输入长度分段计价")}</small> : null}
      </strong>
    </div>
    <div className={styles.configRow}><span>{t("输出定价")}</span><strong>{outputPrice}</strong></div>
    {price?.price_version || price?.source_url ? (
      <div className={styles.infoFootnote}>
        {price?.price_version ? <span>{price.price_version}</span> : null}
        {price?.source_url ? <a href={price.source_url} target="_blank" rel="noreferrer">{t("价格来源")}</a> : null}
      </div>
    ) : null}
  </>;
}
