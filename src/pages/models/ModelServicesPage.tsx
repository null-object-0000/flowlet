import { useEffect, useMemo, useState } from "react";
import { Button, Input, Select, Switch, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconRefresh, IconSearch } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useAccounts, useChannelPresets } from "../../features/channel-accounts";
import { ChannelBrandLogo } from "../../features/channel-accounts/ChannelBrandLogo";
import { useModelActions } from "../../features/exposed-models/useModelActions";
import { useChannelModels, useRouteCandidates } from "../../features/exposed-models/useModels";
import { buildModelServiceItems, type ModelRouteGroup, type ModelServiceItem } from "./modelServiceView";
import secondaryButtonStyles from "../../shared/ui/SecondaryButton.module.css";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";
import styles from "./ModelServicesPage.module.css";

const { Paragraph, Text, Title } = Typography;
type StatusFilter = "all" | "enabled" | "disabled";

export function ModelServicesPage() {
  const { t } = useAppPreferences();
  const accounts = useAccounts();
  const channels = useChannelPresets();
  const routes = useRouteCandidates();
  const channelModels = useChannelModels();
  const actions = useModelActions();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [selectedModel, setSelectedModel] = useState<string | null>(null);

  const models = useMemo(
    () => buildModelServiceItems(routes.data ?? [], accounts.data ?? [], channels.data ?? []),
    [accounts.data, channels.data, routes.data],
  );
  const filtered = useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return models.filter((model) => {
      const statusMatches = status === "all" || (status === "enabled" ? model.enabled : !model.enabled);
      const searchMatches = !keyword || model.publicModel.toLowerCase().includes(keyword)
        || model.routes.some((route) => route.upstream_model.toLowerCase().includes(keyword));
      return statusMatches && searchMatches;
    });
  }, [models, search, status]);

  useEffect(() => {
    if (models.length === 0) setSelectedModel(null);
    else if (!selectedModel || !models.some((model) => model.publicModel === selectedModel)) setSelectedModel(models[0].publicModel);
  }, [models, selectedModel]);

  const selected = models.find((model) => model.publicModel === selectedModel) ?? null;
  const busyModel = actions.toggleExposedModel.isPending ? actions.toggleExposedModel.variables?.modelId : undefined;
  const enabledCount = models.filter((model) => model.enabled).length;
  const availableCount = models.filter((model) => model.available).length;
  const loading = accounts.isLoading || channels.isLoading || routes.isLoading || channelModels.isLoading;
  const error = accounts.error ?? channels.error ?? routes.error ?? channelModels.error;

  const refresh = () => void Promise.all([accounts.refetch(), channels.refetch(), routes.refetch(), channelModels.refetch()]);
  const toggleModel = (model: ModelServiceItem, enabled: boolean) => {
    actions.toggleExposedModel.mutate({ routes: routes.data ?? [], routeIds: model.routeIds, modelId: model.publicModel, enabled });
  };
  const toggleRoute = (modelId: string, routeGroup: ModelRouteGroup, enabled: boolean) => {
    actions.toggleExposedModel.mutate({ routes: routes.data ?? [], routeIds: routeGroup.routeIds, modelId, enabled });
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
              value={status}
              aria-label={t("模型状态")}
              optionList={[
                { value: "all", label: t("全部状态") },
                { value: "enabled", label: t("已启用") },
                { value: "disabled", label: t("已停用") },
              ]}
              onChange={(value) => setStatus(value as StatusFilter)}
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
          busy={busyModel != null}
          onToggleRoute={toggleRoute}
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

function ModelDetail({ model, accounts, channels, busy, onToggleRoute, t }: {
  model: ModelServiceItem | null;
  accounts: ReturnType<typeof useAccounts>["data"] extends (infer T)[] | undefined ? T[] : never;
  channels: ReturnType<typeof useChannelPresets>["data"] extends (infer T)[] | undefined ? T[] : never;
  busy: boolean;
  onToggleRoute: (modelId: string, routeGroup: ModelRouteGroup, enabled: boolean) => void;
  t: (source: string, values?: Record<string, string | number>) => string;
}) {
  if (!model) return <section className={`${styles.detailCard} ${styles.detailEmpty}`}><Text type="tertiary">{t("选择一个模型查看路由配置")}</Text></section>;
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const channelById = new Map(channels.map((channel) => [channel.id, channel]));
  const copy = () => void navigator.clipboard.writeText(model.publicModel);
  return <section className={styles.detailCard}>
    <header className={styles.detailHeader}><ModelLogo model={model} /><span><strong>{model.publicModel}</strong><small>{model.availableAccountCount > 0 ? t("{count} 个可用账号", { count: model.availableAccountCount }) : t("无可用账号")}</small></span></header>
    <div className={styles.detailBody}>
      <DetailSection title={t("基础配置")}>
        <div className={styles.configRow}><span>{t("对外模型名称")}</span><strong>{model.publicModel}</strong><Button theme="borderless" icon={<IconCopy />} aria-label={t("复制模型名称")} onClick={copy} /></div>
      </DetailSection>
      <DetailSection title={t("渠道路由")} note={t("数字越小优先级越高")}>
        {model.routeGroups.map((routeGroup) => {
          const account = accountById.get(routeGroup.accountId);
          const usable = Boolean(account?.enabled && account.api_key.trim() && account.credential_status !== "invalid_key");
          return <div className={styles.routeRow} key={routeGroup.key}>
            <span className={styles.priority}>{routeGroup.priority + 1}</span>
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
