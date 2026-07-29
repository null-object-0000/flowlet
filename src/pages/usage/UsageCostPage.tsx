import { useMemo, useState } from "react";
import { Button, Select, Tooltip, Typography } from "@douyinfe/semi-ui-19";
import { IconInfoCircle } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UsagePeriod, UsageSummaryRow } from "../../domains/usage/types";
import type { DailyUsageTotal } from "../../domains/device-sync/types";
import { useAgentNativeUsageSummary, useUsageSummary } from "../../features/usage/useUsageSummary";
import { useDeviceDailyUsage, useKnownDevices } from "../../features/device-sync/useDeviceSync";
import { useModelPriceCurrencyLookup } from "../../features/usage/useModelPriceCurrencies";
import { RefreshControl } from "../../shared/ui/RefreshControl";
import { useRefreshControl } from "../../shared/ui/useRefreshControl";
import { TokenBreakdownContent, TokenBreakdownTooltip } from "../../shared/ui/TokenBreakdownTooltip";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { buildUsageHeatmap, filterUsageRows, groupUsageByChannel, groupUsageByDay, groupUsageByModel, summarizeUsage, type UsageDay, type UsageHeatmap, type UsageHeatmapCell } from "./usagePresentation";
import { filterAgentNativeUsageRows, groupAgentNativeUsage, summarizeAgentNativeUsage, type AgentNativeUsageBreakdown, type AgentNativeUsageTotals } from "./nativeUsagePresentation";
import { summarizeCombinedUsage, type CombinedUsageTotals } from "./combinedUsagePresentation";
import styles from "./UsageCostPage.module.css";
import { dominantCostCurrency, formatCost, formatMultiCurrencyCost } from "../../shared/formatters/cost";
import { formatCompactNumber as formatCompact, formatInteger } from "../../shared/formatters/number";

const { Paragraph, Title } = Typography;
type TrendMetric = "cost" | "tokens";
type UsageSource = "flowlet" | "native" | "combined";

export function UsageCostPage() {
  const { language, t } = useAppPreferences();
  const refresh = useRefreshControl({ intervalMs: 30_000 });
  const [period, setPeriod] = useState<UsagePeriod>("month");
  const [usageSource, setUsageSource] = useState<UsageSource>("flowlet");
  const [deviceSelection, setDeviceSelection] = useState("current");
  const devices = useKnownDevices();
  const currentDevice = devices.data?.find((device) => device.isCurrent) ?? null;
  const sharedView = deviceSelection !== "current";
  const selectedDeviceId = deviceSelection === "all" ? null : deviceSelection === "current" ? currentDevice?.deviceId ?? null : deviceSelection;
  const sharedUsage = useDeviceDailyUsage(selectedDeviceId, sharedView);
  const usage = useUsageSummary(period, refresh.autoRefresh);
  const nativeUsage = useAgentNativeUsageSummary(refresh.autoRefresh, usageSource !== "flowlet");
  const [metric, setMetric] = useState<TrendMetric>("tokens");
  const flowletInitialLoading = sharedView
    ? sharedUsage.isPending && sharedUsage.data == null
    : usage.query.isPending && usage.query.data == null;
  const sourceRows = useMemo(
    () => sharedView ? dailyTotalsToUsageRows(sharedUsage.data ?? []) : usage.query.data ?? [],
    [sharedUsage.data, sharedView, usage.query.data],
  );
  const rows = useMemo(() => filterUsageRows(sourceRows, period), [period, sourceRows]);
  const priceLookup = useModelPriceCurrencyLookup();
  const { modelCurrencyOf, channelCurrencyOf } = priceLookup;
  const summary = useMemo(() => summarizeUsage(rows, modelCurrencyOf), [rows, modelCurrencyOf]);
  const days = useMemo(() => groupUsageByDay(rows), [rows]);
  const activity = useMemo(() => buildUsageHeatmap(sourceRows, period, new Date(), language, !sharedView), [language, period, sharedView, sourceRows]);
  const models = useMemo(() => sharedView ? [] : groupUsageByModel(rows, modelCurrencyOf), [rows, modelCurrencyOf, sharedView]);
  const channels = useMemo(() => sharedView ? [] : groupUsageByChannel(rows, channelCurrencyOf), [rows, channelCurrencyOf, sharedView]);
  const nativeRows = useMemo(
    () => filterAgentNativeUsageRows(nativeUsage.data ?? [], period),
    [nativeUsage.data, period],
  );
  const nativeSummary = useMemo(() => summarizeAgentNativeUsage(nativeRows), [nativeRows]);
  const nativeAgents = useMemo(() => groupAgentNativeUsage(nativeRows), [nativeRows]);
  const combinedSummary = useMemo(
    () => summarizeCombinedUsage(summary, nativeSummary),
    [nativeSummary, summary],
  );
  const totalCostLabel = formatMultiCurrencyCost(summary.costByCurrency);
  const chartCostCurrency = dominantCostCurrency(summary.costByCurrency);
  const cacheHitRate = summary.cacheMeasuredInputTokens > 0
    ? summary.cachedInputTokens / summary.cacheMeasuredInputTokens
    : null;
  const cacheDetails = <TokenBreakdownContent
    language={language}
    t={t}
    tokens={{
      total: summary.tokens,
      input: summary.inputTokens,
      cachedInput: summary.cachedInputTokens,
      uncachedInput: summary.uncachedInputTokens,
      output: summary.outputTokens,
      cacheHitRate,
    }}
  />;
  const periodLabel = {
    all: t("全部时间"),
    year: t("今年"),
    quarter: t("本季度"),
    month: t("本月"),
    week: t("本周"),
    today: t("今日"),
  }[period];
  const nativeSourceActive = usageSource !== "flowlet";
  const combinedLoading = flowletInitialLoading || (nativeUsage.isPending && nativeUsage.data == null);
  const refreshIsFetching = usageSource === "flowlet"
    ? usage.query.isFetching
    : usageSource === "native"
      ? nativeUsage.isFetching
      : usage.query.isFetching || nativeUsage.isFetching;
  const refreshUpdatedAt = usageSource === "flowlet"
    ? usage.query.dataUpdatedAt
    : usageSource === "native"
      ? nativeUsage.dataUpdatedAt
      : oldestUpdatedAt(usage.query.dataUpdatedAt, nativeUsage.dataUpdatedAt);

  return <main className={styles.page}>
    <header className={styles.pageHeading}>
      <div><Title heading={3}>{t("用量成本")}</Title><Paragraph>{
        usageSource === "combined"
          ? t("汇总当前设备经过 Flowlet 与 Agent 原生会话的 Token 和 API 等价价值")
          : usageSource === "native"
            ? t("查看未经过 Flowlet 的 Agent 原生 Token、费用与 API 等价价值")
            : sharedView
              ? t("共享设备仅展示每日请求与 Token 汇总")
              : t("查看模型、渠道与账号维度的 Token 消耗和预估费用")
      }</Paragraph></div>
      <Select
        className={styles.sourceSelect}
        insetLabel={t("来源")}
        value={usageSource}
        aria-label={t("使用来源")}
        optionList={[
          { value: "flowlet", label: t("经过 Flowlet") },
          { value: "native", label: t("Agent 原生") },
          { value: "combined", label: t("综合") },
        ]}
        onChange={(value) => setUsageSource(value as UsageSource)}
      />
      {usageSource === "flowlet" ? <Select
        className={styles.deviceSelect}
        insetLabel={t("设备")}
        value={deviceSelection}
        aria-label={t("设备")}
        optionList={[
          { value: "all", label: t("全部设备") },
          {
            value: "current",
            label: currentDevice ? `${t("当前设备")} · ${currentDevice.displayName}` : t("当前设备"),
          },
          ...(devices.data ?? []).filter((device) => !device.isCurrent).map((device) => ({
            value: device.deviceId,
            label: device.displayName,
          })),
        ]}
        onChange={(value) => {
          const next = String(value);
          setDeviceSelection(next);
          if (next !== "current") setMetric("tokens");
        }}
      /> : null}
      <Select
        value={period}
        aria-label={t("统计周期")}
        optionList={[
          { value: "all", label: t("全部时间") },
          { value: "year", label: t("今年") },
          { value: "quarter", label: t("本季度") },
          { value: "month", label: t("本月") },
          { value: "week", label: t("本周") },
          { value: "today", label: t("今日") },
        ]}
        onChange={(value) => setPeriod(value as UsagePeriod)}
      />
      <RefreshControl
        autoRefresh={refresh.autoRefresh}
        onToggleAutoRefresh={refresh.toggleAutoRefresh}
        isFetching={refreshIsFetching}
        lastUpdatedAt={refreshUpdatedAt}
        intervalMs={refresh.intervalMs}
        onRefresh={() => {
          if (usageSource === "combined") {
            void Promise.all([usage.query.refetch(), nativeUsage.refetch()]);
            return;
          }
          void (nativeSourceActive ? nativeUsage.refetch() : usage.query.refetch());
        }}
        language={language}
        t={t}
      />
    </header>

    {usageSource === "combined" ? <CombinedUsageContent
      language={language}
      t={t}
      periodLabel={periodLabel}
      summary={combinedSummary}
      flowletUnknown={summary.unknown}
      nativeSummary={nativeSummary}
      loading={combinedLoading}
      flowletError={usage.query.error}
      nativeError={nativeUsage.error}
      onRetry={() => void Promise.all([usage.query.refetch(), nativeUsage.refetch()])}
    /> : usageSource === "native" ? <AgentNativeUsageContent
      language={language}
      t={t}
      periodLabel={periodLabel}
      summary={nativeSummary}
      agents={nativeAgents}
      loading={nativeUsage.isPending && nativeUsage.data == null}
      error={nativeUsage.error}
      onRetry={() => void nativeUsage.refetch()}
    /> : flowletInitialLoading ? <UsageCostSkeleton loadingLabel={t("正在加载用量…")} /> : <>
    <section className={styles.stats} aria-label={t("用量统计")}>
      <Stat label={t("{period}预估费用", { period: periodLabel })} value={sharedView ? "—" : totalCostLabel} meta={sharedView ? t("每日共享摘要不包含费用") : t("基于已知价格")} />
      <Stat label={t("{period} Token 消耗", { period: periodLabel })} value={formatCompact(summary.tokens, language)} meta={t("输入 {input} · 输出 {output}", { input: formatCompact(summary.inputTokens, language), output: formatCompact(summary.outputTokens, language) })} />
      <Stat label={t("{period}请求量", { period: periodLabel })} value={formatInteger(summary.requests, language)} meta={sharedView ? t("设备每日摘要") : t("本地代理记录")} />
      <Stat label={t("缓存命中率")} value={cacheHitRate == null ? "—" : formatPercent(cacheHitRate)} meta={t("缓存 {cached} · 未缓存 {uncached}", { cached: formatCompact(summary.cachedInputTokens, language), uncached: formatCompact(summary.uncachedInputTokens, language) })} tooltip={cacheDetails} />
    </section>

    {(sharedView ? sharedUsage.isError : usage.query.isError) ? <div className={styles.state}><strong>{t("用量数据加载失败")}</strong><span>{sharedView ? sharedUsage.error?.message : usage.query.error?.message}</span><Button onClick={() => void (sharedView ? sharedUsage.refetch() : usage.query.refetch())}>{t("重试")}</Button></div> : null}
    {!(sharedView ? sharedUsage.isError : usage.query.isError) ? <div className={styles.workspace}>
      <section className={styles.mainCard}>
        <header className={styles.cardHeader}>
          <div><strong>{t(metric === "tokens" ? "Token 活动" : "消耗趋势")}</strong><small>{t(activity.granularity === "hour" ? "{period}按小时汇总" : activity.granularity === "week" ? "{period}分时汇总" : "{period}每日汇总", { period: periodLabel })}</small></div>
          <div className={styles.segments}>{!sharedView ? <button type="button" className={metric === "cost" ? styles.active : ""} onClick={() => setMetric("cost")}>{t("费用")}</button> : null}<button type="button" className={metric === "tokens" ? styles.active : ""} onClick={() => setMetric("tokens")}>Tokens</button></div>
        </header>
        <div className={styles.trend}>
          <div className={styles.trendSummary}><strong>{metric === "cost" ? totalCostLabel : `${formatCompact(summary.tokens, language)} Tokens`}</strong><span>{periodLabel}{t("累计")}</span></div>
          {metric === "tokens" ? (
            <TokenActivityHeatmap activity={activity} language={language} lessLabel={t("少")} moreLabel={t("多")} />
          ) : (
            <TrendChart days={days} metric={metric} language={language} costCurrency={chartCostCurrency} emptyLabel={usage.query.isLoading ? t("正在加载用量…") : t("当前周期暂无用量数据")} />
          )}
        </div>
        <div className={styles.breakdown}>
          <div className={styles.breakdownHead}><span>{t("模型")}</span><span>{t("请求量")}</span><span>Tokens</span><span>{t("缓存命中率")}</span><span>{t("费用")}</span><span>{t("费用占比")}</span></div>
          <div className={styles.breakdownList}>
            {models.length === 0 ? <div className={styles.empty}>{t("暂无模型用量")}</div> : models.map((model) => <div className={styles.breakdownRow} key={model.key}>
              <span className={styles.modelCell}><ChannelBrandLogo channelId={model.brandId ?? "unknown-channel"} name={model.label} /><strong>{model.label}</strong></span>
              <span>{formatInteger(model.requests, language)}</span>
              <TokenBreakdownTooltip
                language={language}
                t={t}
                tokens={{
                  total: model.tokens,
                  input: model.inputTokens,
                  cachedInput: model.cachedInputTokens,
                  uncachedInput: model.uncachedInputTokens,
                  output: model.outputTokens,
                  cacheHitRate: model.cacheMeasuredInputTokens > 0 ? model.cachedInputTokens / model.cacheMeasuredInputTokens : null,
                }}
              >
                <span className={styles.modelTokens}>{formatCompact(model.tokens, language)}</span>
              </TokenBreakdownTooltip>
              <span>{model.cacheMeasuredInputTokens > 0 ? formatPercent(model.cachedInputTokens / model.cacheMeasuredInputTokens) : "—"}</span>
              <span className={styles.costCell} title={formatCost(model.cost, model.currency)}>{formatCost(model.cost, model.currency)}</span>
              <span className={styles.share}><i><b style={{ width: `${Math.max(0, Math.min(100, model.share * 100))}%` }} /></i><em>{formatPercent(model.share)}</em></span>
            </div>)}
          </div>
        </div>
      </section>

      <aside className={styles.side}>
        <section className={styles.coverageCard}>
          <header>
            <strong>{t("数据完整度")}</strong>
            <Tooltip content={t("费用仅统计 Token 与价格均已知的请求")}>
              <IconInfoCircle className={styles.hintIcon} role="img" aria-label={t("费用仅统计 Token 与价格均已知的请求")} />
            </Tooltip>
          </header>
          <div className={styles.coverageValue}><strong>{summary.requests > 0 ? formatPercent((summary.requests - summary.unknown) / summary.requests) : "-"}</strong><span>{t("请求包含可统计用量")}</span></div>
          <div className={styles.coverageTrack}><i style={{ width: `${summary.requests > 0 ? Math.max(0, (summary.requests - summary.unknown) / summary.requests * 100) : 0}%` }} /></div>
        </section>
        <section className={styles.channelCard}>
          <header><strong>{t("渠道成本")}</strong><span>{t("按预估费用排序")}</span></header>
          <div className={styles.channelList}>{channels.length === 0 ? <div className={styles.empty}>{t("暂无渠道用量")}</div> : channels.map((channel) => <div className={styles.channelRow} key={channel.key}>
            <ChannelBrandLogo channelId={channel.brandId ?? channel.key} name={channel.label} />
            <span>
              <strong>{channel.label}</strong>
              <TokenBreakdownTooltip
                language={language}
                t={t}
                tokens={{
                  total: channel.tokens,
                  input: channel.inputTokens,
                  cachedInput: channel.cachedInputTokens,
                  uncachedInput: channel.uncachedInputTokens,
                  output: channel.outputTokens,
                  cacheHitRate: channel.cacheMeasuredInputTokens > 0 ? channel.cachedInputTokens / channel.cacheMeasuredInputTokens : null,
                  requests: channel.requests,
                }}
              >
                <small className={styles.channelTokens}>{formatCompact(channel.tokens, language)} Tokens</small>
              </TokenBreakdownTooltip>
            </span>
            <span><strong title={formatCost(channel.cost, channel.currency)}>{formatCost(channel.cost, channel.currency)}</strong><small>{formatPercent(channel.share)}</small></span>
          </div>)}</div>
          <footer><span>{t("总计 {count} 个渠道/账号", { count: channels.length })}</span><strong>{totalCostLabel}</strong></footer>
        </section>
      </aside>
    </div> : null}
    </>}
  </main>;
}

function CombinedUsageContent({
  language,
  t,
  periodLabel,
  summary,
  flowletUnknown,
  nativeSummary,
  loading,
  flowletError,
  nativeError,
  onRetry,
}: {
  language: "zh-CN" | "en-US";
  t: ReturnType<typeof useAppPreferences>["t"];
  periodLabel: string;
  summary: CombinedUsageTotals;
  flowletUnknown: number;
  nativeSummary: AgentNativeUsageTotals;
  loading: boolean;
  flowletError: Error | null;
  nativeError: Error | null;
  onRetry: () => void;
}) {
  if (loading) return <UsageCostSkeleton loadingLabel={t("正在加载综合用量…")} />;
  const totalValue = formatCurrencyMap(summary.apiEquivalentValueByCurrency);
  const flowletValue = formatCurrencyMap(summary.flowletValueByCurrency);
  const nativeValue = formatCurrencyMap(summary.nativeValueByCurrency);
  const flowletCoverage = summary.requests > 0
    ? (summary.requests - flowletUnknown) / summary.requests
    : null;
  const nativePricingTurns = nativeSummary.pricedTurns + nativeSummary.unpricedTurns;
  const nativePricingCoverage = nativePricingTurns > 0
    ? nativeSummary.pricedTurns / nativePricingTurns
    : null;
  const flowletTokenShare = summary.tokens > 0 ? summary.flowletTokens / summary.tokens : null;
  const errors = [flowletError, nativeError].filter((error): error is Error => error != null);

  return <>
    <section className={styles.stats} aria-label={t("综合用量统计")}>
      <Stat
        label={t("{period} API 等价总价值", { period: periodLabel })}
        value={totalValue}
        meta={t("Flowlet {flowlet} · 原生 {native}", { flowlet: flowletValue, native: nativeValue })}
      />
      <Stat
        label={t("{period} Token 消耗", { period: periodLabel })}
        value={formatCompact(summary.tokens, language)}
        meta={t("Flowlet {flowlet} · 原生 {native}", {
          flowlet: formatCompact(summary.flowletTokens, language),
          native: formatCompact(summary.nativeTokens, language),
        })}
      />
      <Stat
        label={t("{period}使用规模", { period: periodLabel })}
        value={`${formatInteger(summary.requests, language)} / ${formatInteger(summary.nativeTurns, language)}`}
        meta={t("Flowlet 请求 / Agent 原生轮次")}
      />
      <Stat
        label={t("数据覆盖")}
        value={flowletCoverage == null ? "—" : formatPercent(flowletCoverage)}
        meta={t("Flowlet 用量覆盖 · 原生计价 {coverage}", {
          coverage: nativePricingCoverage == null ? "—" : formatPercent(nativePricingCoverage),
        })}
      />
    </section>

    {errors.length > 0 ? <div className={styles.state}>
      <strong>{t("综合用量加载失败")}</strong>
      <span>{errors.map((error) => error.message).join(" · ")}</span>
      <Button onClick={onRetry}>{t("重试")}</Button>
    </div> : <div className={styles.workspace}>
      <section className={`${styles.mainCard} ${styles.nativeMainCard}`}>
        <header className={styles.cardHeader}>
          <div>
            <strong>{t("来源拆分")}</strong>
            <small>{t("Token 可相加；价值按原币合并，不进行汇率换算")}</small>
          </div>
        </header>
        <div className={styles.combinedBreakdown}>
          <div className={styles.combinedBreakdownHead}>
            <span>{t("来源")}</span>
            <span>{t("使用规模")}</span>
            <span>Tokens</span>
            <span>{t("API 等价价值")}</span>
            <span>{t("归集方式")}</span>
          </div>
          <div className={styles.breakdownList}>
            <div className={styles.combinedBreakdownRow}>
              <span className={styles.combinedSourceCell}>
                <i>F</i>
                <span><strong>{t("经过 Flowlet")}</strong><small>{t("代理请求记录")}</small></span>
              </span>
              <span>{t("{count} 次请求", { count: formatInteger(summary.requests, language) })}</span>
              <span className={styles.modelTokens} title={`${formatInteger(summary.flowletTokens, language)} Tokens`}>{formatCompact(summary.flowletTokens, language)}</span>
              <span className={styles.costCell} title={flowletValue}>{flowletValue}</span>
              <span>{t("按请求发生时间精确归集")}</span>
            </div>
            <div className={styles.combinedBreakdownRow}>
              <span className={styles.combinedSourceCell}>
                <i>A</i>
                <span><strong>{t("Agent 原生")}</strong><small>{t("未被 Flowlet 观测的根会话")}</small></span>
              </span>
              <span>{t("{sessions} 会话 · {turns} 轮", {
                sessions: formatInteger(summary.nativeSessions, language),
                turns: formatInteger(summary.nativeTurns, language),
              })}</span>
              <span className={styles.modelTokens} title={`${formatInteger(summary.nativeTokens, language)} Tokens`}>{formatCompact(summary.nativeTokens, language)}</span>
              <span className={styles.costCell} title={nativeValue}>{nativeValue}</span>
              <span>{t("按会话最近活动日近似归集")}</span>
            </div>
          </div>
        </div>
      </section>

      <aside className={styles.side}>
        <section className={styles.coverageCard}>
          <header>
            <strong>{t("Token 来源占比")}</strong>
            <Tooltip content={t("仅按 Token 数量计算，不代表实际支付金额")}>
              <IconInfoCircle className={styles.hintIcon} role="img" aria-label={t("Token 来源占比说明")} />
            </Tooltip>
          </header>
          <div className={styles.coverageValue}>
            <strong>{flowletTokenShare == null ? "—" : formatPercent(flowletTokenShare)}</strong>
            <span>{t("Token 经过 Flowlet")}</span>
          </div>
          <div className={styles.coverageTrack}><i style={{ width: `${flowletTokenShare == null ? 0 : flowletTokenShare * 100}%` }} /></div>
        </section>
        <section className={`${styles.channelCard} ${styles.nativeScopeCard}`}>
          <header><strong>{t("综合统计口径")}</strong><span>{t("保守去重")}</span></header>
          <div className={styles.nativeScopeBody}>
            <p>{t("综合视图仅统计当前设备；原生会话不会同步到其他设备。")}</p>
            <p>{t("已被 Flowlet 观测的会话只使用代理请求数据，原生摘要不会重复累加。")}</p>
            <p>{t("综合总价值仅合并 Flowlet 预估费用与原生 API 等价价值。")}</p>
            <p>{t("原生实际费用与套餐消耗保持独立，不计入综合总价值。")}</p>
            <p>{t("原生数据按会话最近活动日筛选，周期边界属于近似统计。")}</p>
            {nativeSummary.truncatedSessions > 0 ? <p className={styles.warningText}>{t("{count} 个会话摘要可能被截断", { count: nativeSummary.truncatedSessions })}</p> : null}
          </div>
          <footer><span>{t("两类来源合计")}</span><strong>{formatCompact(summary.tokens, language)} Tokens</strong></footer>
        </section>
      </aside>
    </div>}
  </>;
}

function AgentNativeUsageContent({
  language,
  t,
  periodLabel,
  summary,
  agents,
  loading,
  error,
  onRetry,
}: {
  language: "zh-CN" | "en-US";
  t: ReturnType<typeof useAppPreferences>["t"];
  periodLabel: string;
  summary: AgentNativeUsageTotals;
  agents: AgentNativeUsageBreakdown[];
  loading: boolean;
  error: Error | null;
  onRetry: () => void;
}) {
  if (loading) return <UsageCostSkeleton loadingLabel={t("正在加载 Agent 原生用量…")} />;
  const usageCoverage = summary.sessions > 0 ? summary.sessionsWithUsage / summary.sessions : null;
  const pricingTurns = summary.pricedTurns + summary.unpricedTurns;
  const pricingCoverage = pricingTurns > 0 ? summary.pricedTurns / pricingTurns : null;
  const nativeCost = formatCurrencyMap(summary.nativeCostByCurrency);
  const apiEquivalent = formatCurrencyMap(summary.apiEquivalentByCurrency);
  const planConsumption = formatCurrencyMap(summary.planConsumptionByCurrency);

  return <>
    <section className={styles.stats} aria-label={t("Agent 原生用量统计")}>
      <Stat
        label={t("{period} API 等价价值", { period: periodLabel })}
        value={apiEquivalent}
        meta={nativeCost === "—" ? t("不是实际支付金额") : t("原生上报费用 {cost}", { cost: nativeCost })}
      />
      <Stat
        label={t("{period} Token 消耗", { period: periodLabel })}
        value={formatCompact(summary.tokens, language)}
        meta={t("输入 {input} · 输出 {output}", {
          input: formatCompact(summary.inputTokens, language),
          output: formatCompact(summary.outputTokens, language),
        })}
      />
      <Stat
        label={t("{period}原生会话", { period: periodLabel })}
        value={formatInteger(summary.sessions, language)}
        meta={t("{turns} 个 Agent 轮次", { turns: formatInteger(summary.turns, language) })}
      />
      <Stat
        label={t("计价覆盖率")}
        value={pricingCoverage == null ? "—" : formatPercent(pricingCoverage)}
        meta={planConsumption === "—" ? t("按可匹配公开价格的轮次") : t("套餐消耗 {cost}", { cost: planConsumption })}
      />
    </section>

    {error ? <div className={styles.state}>
      <strong>{t("Agent 原生用量加载失败")}</strong>
      <span>{error.message}</span>
      <Button onClick={onRetry}>{t("重试")}</Button>
    </div> : <div className={styles.workspace}>
      <section className={`${styles.mainCard} ${styles.nativeMainCard}`}>
        <header className={styles.cardHeader}>
          <div>
            <strong>{t("Agent 原生用量")}</strong>
            <small>{t("仅统计未经过 Flowlet 的根会话，按最近活动日归集")}</small>
          </div>
        </header>
        <div className={styles.nativeBreakdown}>
          <div className={styles.nativeBreakdownHead}>
            <span>Agent / {t("模型")}</span>
            <span>{t("会话")}</span>
            <span>{t("轮次")}</span>
            <span>Tokens</span>
            <span>{t("API 等价")}</span>
            <span>{t("原生费用")}</span>
          </div>
          <div className={styles.breakdownList}>
            {agents.length === 0 ? <div className={styles.empty}>{t("当前周期暂无 Agent 原生用量")}</div> : agents.map((agent) => {
              const agentApiEquivalent = formatCurrencyMap(agent.apiEquivalentByCurrency);
              const agentNativeCost = formatCurrencyMap(agent.nativeCostByCurrency);
              return <div className={styles.nativeBreakdownRow} key={agent.agentType}>
                <span className={styles.nativeAgentCell}>
                  <i>{agentInitial(agent.agentType)}</i>
                  <span>
                    <strong>{agentLabel(agent.agentType)}</strong>
                    <small title={agent.models.join(" · ")}>{agent.models.length > 0 ? agent.models.join(" · ") : t("模型未知")}</small>
                  </span>
                </span>
                <span>{formatInteger(agent.sessions, language)}</span>
                <span>{formatInteger(agent.turns, language)}</span>
                <span className={styles.modelTokens} title={`${formatInteger(agent.tokens, language)} Tokens`}>{formatCompact(agent.tokens, language)}</span>
                <span className={styles.costCell} title={agentApiEquivalent}>{agentApiEquivalent}</span>
                <span className={styles.costCell} title={agentNativeCost}>{agentNativeCost}</span>
              </div>;
            })}
          </div>
        </div>
      </section>

      <aside className={styles.side}>
        <section className={styles.coverageCard}>
          <header>
            <strong>{t("数据完整度")}</strong>
            <Tooltip content={t("有原生 Token 摘要的会话占比；计价覆盖率另按可匹配公开价格的轮次计算")}>
              <IconInfoCircle className={styles.hintIcon} role="img" aria-label={t("原生用量数据完整度说明")} />
            </Tooltip>
          </header>
          <div className={styles.coverageValue}>
            <strong>{usageCoverage == null ? "—" : formatPercent(usageCoverage)}</strong>
            <span>{t("会话包含 Token 摘要")}</span>
          </div>
          <div className={styles.coverageTrack}><i style={{ width: `${usageCoverage == null ? 0 : usageCoverage * 100}%` }} /></div>
        </section>
        <section className={`${styles.channelCard} ${styles.nativeScopeCard}`}>
          <header><strong>{t("统计口径")}</strong><span>{t("保守去重")}</span></header>
          <div className={styles.nativeScopeBody}>
            <p>{t("已被 Flowlet 观测的会话优先使用代理请求数据，不重复累加原生摘要。")}</p>
            <p>{t("当前按会话最近活动日筛选，不代表 Token 的精确发生日期。")}</p>
            <p>{t("API 等价价值、原生上报费用和套餐消耗彼此独立，不合并为实际成本。")}</p>
            {summary.truncatedSessions > 0 ? <p className={styles.warningText}>{t("{count} 个会话摘要可能被截断", { count: summary.truncatedSessions })}</p> : null}
          </div>
          <footer><span>{t("总计 {count} 类 Agent", { count: agents.length })}</span><strong>{formatCompact(summary.tokens, language)} Tokens</strong></footer>
        </section>
      </aside>
    </div>}
  </>;
}

function UsageCostSkeleton({ loadingLabel }: { loadingLabel: string }) {
  return <>
    <section className={styles.stats} aria-label={loadingLabel} aria-busy="true">
      {Array.from({ length: 4 }, (_, index) => <div className={styles.stat} key={index} aria-hidden="true">
        <span className={`${styles.skeletonLine} ${styles.skeletonLabel}`} />
        <span className={`${styles.skeletonLine} ${styles.skeletonValue}`} />
        <span className={`${styles.skeletonLine} ${styles.skeletonMeta}`} />
      </div>)}
    </section>
    <div className={styles.workspace} aria-hidden="true">
      <section className={`${styles.mainCard} ${styles.skeletonCard}`}>
        <header className={styles.cardHeader}><span className={`${styles.skeletonLine} ${styles.skeletonHeading}`} /></header>
        <div className={styles.skeletonTrend}>
          <span className={`${styles.skeletonLine} ${styles.skeletonTotal}`} />
          <div className={styles.skeletonChart} />
        </div>
        <div className={styles.skeletonRows}>
          {Array.from({ length: 4 }, (_, index) => <div key={index}><span /><span /><span /><span /></div>)}
        </div>
      </section>
      <aside className={styles.side}>
        <section className={`${styles.coverageCard} ${styles.skeletonSideCard}`}>
          <span className={`${styles.skeletonLine} ${styles.skeletonHeading}`} />
          <span className={`${styles.skeletonLine} ${styles.skeletonValue}`} />
          <span className={`${styles.skeletonLine} ${styles.skeletonTrack}`} />
        </section>
        <section className={`${styles.channelCard} ${styles.skeletonSideCard}`}>
          <span className={`${styles.skeletonLine} ${styles.skeletonHeading}`} />
          {Array.from({ length: 4 }, (_, index) => <span className={`${styles.skeletonLine} ${styles.skeletonChannel}`} key={index} />)}
        </section>
      </aside>
    </div>
  </>;
}

function formatCurrencyMap(values: Record<string, number>) {
  return Object.values(values).some((value) => Number.isFinite(value) && value > 0)
    ? formatMultiCurrencyCost(values, 4)
    : "—";
}

function oldestUpdatedAt(left: number | undefined, right: number | undefined) {
  if (!left) return right;
  if (!right) return left;
  return Math.min(left, right);
}

function agentLabel(agentType: string) {
  if (agentType === "claude-code") return "Claude Code";
  if (agentType === "codex-desktop") return "ChatGPT";
  if (agentType === "codex-cli") return "Codex CLI";
  if (agentType === "opencode") return "OpenCode";
  if (agentType === "pi") return "Pi";
  return agentType;
}

function agentInitial(agentType: string) {
  return agentLabel(agentType).slice(0, 1).toUpperCase();
}

function Stat({ label, value, meta, tooltip }: { label: string; value: string; meta: string; tooltip?: React.ReactNode }) {
  const valueContent = <strong className={tooltip ? styles.statTooltip : undefined} title={value}>{value}</strong>;
  return <div className={styles.stat}><span>{label}</span>{tooltip ? <Tooltip content={tooltip}>{valueContent}</Tooltip> : valueContent}<small title={meta}>{meta}</small></div>;
}

function TrendChart({ days, metric, language, costCurrency, emptyLabel }: { days: UsageDay[]; metric: TrendMetric; language: "zh-CN" | "en-US"; costCurrency: string | null; emptyLabel: string }) {
  if (days.length === 0) return <div className={styles.chartEmpty}>{emptyLabel}</div>;
  const values = days.map((day) => metric === "cost" ? day.cost : day.tokens);
  const max = Math.max(...values, 1);
  const startX = 36;
  const endX = 592;
  const topY = 18;
  const bottomY = 132;
  const points = values.map((value, index) => ({
    x: days.length === 1 ? (startX + endX) / 2 : startX + (endX - startX) * index / (days.length - 1),
    y: bottomY - (bottomY - topY) * value / max,
  }));
  const line = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  const area = `${line} L${points[points.length - 1]?.x ?? endX} ${bottomY} L${points[0].x} ${bottomY} Z`;
  const labelIndexes = [...new Set([0, Math.floor((days.length - 1) / 2), days.length - 1])];
  return <svg className={styles.chart} viewBox="0 0 610 158" preserveAspectRatio="none" aria-label="usage trend">
    <defs><linearGradient id="flowletUsageArea" x1="0" x2="0" y1="0" y2="1"><stop offset="0%" stopColor="var(--semi-color-primary)" stopOpacity=".38" /><stop offset="100%" stopColor="var(--semi-color-primary)" stopOpacity="0" /></linearGradient></defs>
    {[18, 56, 94, 132].map((y) => <line key={y} className={styles.gridLine} x1="36" y1={y} x2="600" y2={y} />)}
    <text className={styles.chartLabel} x="1" y="21">{metric === "cost" ? formatCost(max, costCurrency) : formatCompact(max, language)}</text>
    <path className={styles.chartArea} d={area} /><path className={styles.chartLine} d={line} />
    {points.map((point, index) => <circle key={days[index].date} className={styles.chartDot} cx={point.x} cy={point.y} r="2.8" />)}
    {labelIndexes.map((index) => <text key={days[index].date} className={styles.chartLabel} x={Math.max(0, Math.min(565, points[index].x - 16))} y="153">{days[index].date.slice(5)}</text>)}
  </svg>;
}

function TokenActivityHeatmap({ activity, language, lessLabel, moreLabel }: { activity: UsageHeatmap; language: "zh-CN" | "en-US"; lessLabel: string; moreLabel: string }) {
  const columnStyle = { gridTemplateColumns: `repeat(${activity.columns}, minmax(0, 1fr))` };
  const gridStyle = {
    ...columnStyle,
    ...(activity.rows ? { gridTemplateRows: `repeat(${activity.rows}, minmax(0, 1fr))` } : {}),
  };
  const cells = activity.cells.map((cell) => {
    const title = heatmapCellTitle(activity, cell, language);
    return <span key={cell.bucket} className={`${styles.heatmapCell} ${styles[`heatLevel${cell.level}`]} ${cell.outside ? styles.outside : ""}`} title={title} aria-label={title} />;
  });
  const axisLabels = <div className={styles.heatmapLabels} style={columnStyle}>
    {activity.labels.map((label) => <span key={`${label.column}-${label.label}`} style={{ gridColumn: label.column }}>{label.label}</span>)}
  </div>;
  // 周分时视图：左侧星期标签 + 7×24 网格 + 底部小时刻度，与其余周期的顶部标签布局不同。
  if (activity.granularity === "week") {
    return <div className={styles.heatmapWeek}>
      <div className={styles.heatmapRowLabels}>{(activity.rowLabels ?? []).map((label) => <span key={label}>{label}</span>)}</div>
      <div className={styles.heatmapGrid} style={gridStyle}>{cells}</div>
      {axisLabels}
      <HeatmapLegend lessLabel={lessLabel} moreLabel={moreLabel} />
    </div>;
  }
  return <div className={`${styles.heatmap} ${styles[`heatmap-${activity.granularity}`]} ${styles[`heatmap-${activity.bucketUnit}-buckets`]}`}>
    {axisLabels}
    <div className={styles.heatmapGrid} style={gridStyle}>{cells}</div>
    <HeatmapLegend lessLabel={lessLabel} moreLabel={moreLabel} />
  </div>;
}

function HeatmapLegend({ lessLabel, moreLabel }: { lessLabel: string; moreLabel: string }) {
  return <div className={styles.heatmapLegend}><span>{lessLabel}</span>{[0, 1, 2, 3, 4].map((level) => <i key={level} className={`${styles.heatmapCell} ${styles[`heatLevel${level}`]}`} />)}<span>{moreLabel}</span></div>;
}

function heatmapCellTitle(activity: UsageHeatmap, cell: UsageHeatmapCell, language: "zh-CN" | "en-US") {
  if (activity.granularity === "hour") {
    const timeLabel = new Date(cell.bucket).toLocaleString(language, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
    return `${timeLabel} · ${formatInteger(cell.tokens, language)} Tokens`;
  }
  if (activity.granularity === "week") {
    const timeLabel = new Date(cell.bucket).toLocaleString(language, { weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
    return `${timeLabel} · ${formatInteger(cell.tokens, language)} Tokens`;
  }
  const date = new Date(activity.bucketUnit === "month" ? `${cell.bucket}-01T00:00:00` : `${cell.bucket.slice(0, 10)}T00:00:00`);
  const timeLabel = activity.bucketUnit === "month"
    ? date.toLocaleDateString(language, { year: "numeric", month: "long" })
    : date.toLocaleDateString(language);
  return `${timeLabel} · ${formatInteger(cell.tokens, language)} Tokens`;
}

function dailyTotalsToUsageRows(days: DailyUsageTotal[]): UsageSummaryRow[] {
  return days.map((day) => ({
    date: day.date,
    client_id: null,
    client_name: null,
    channel_id: null,
    channel_name: null,
    account_id: null,
    account_name: null,
    upstream_model: null,
    request_count: day.requestCount,
    known_tokens: day.knownTokens,
    input_tokens: day.inputTokens,
    input_cached_tokens: day.inputCachedTokens,
    input_uncached_tokens: day.inputUncachedTokens,
    cache_measured_input_tokens: day.cacheMeasuredInputTokens,
    output_tokens: day.outputTokens,
    unknown_count: day.unknownCount,
    estimated_cost: 0,
  }));
}

/** Cost cell formatter: currency symbol follows the model's pricing currency
 *  (¥ / $ / "credits"), with extra precision for sub-cent amounts. */
function formatPercent(value: number) { return `${(value * 100).toFixed(1)}%`; }
