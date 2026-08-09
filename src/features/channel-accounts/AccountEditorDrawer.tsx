import { useMemo, useState } from "react";
import { Button, Checkbox, Input, Pagination, Progress, Select, SideSheet, Space, Switch, Tag, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconChevronUp, IconExternalOpen, IconRefresh } from "@douyinfe/semi-icons";
import { toAppError } from "../../platform/tauri/client";
import { accountCommands } from "../../domains/account/commands";
import { effectiveOpenAiBaseUrl, type AccountBalanceSnapshot, type AccountResourceMode, type AccountResourceSyncMode, type ChannelAccount, type ModelSyncResult } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import {
  CHATGPT_CHANNEL_ID,
  CHATGPT_PSEUDO_PRESET,
  CUSTOM_CHANNEL_ID,
  FLOWLET_SUPPORTED_MODELS,
  QWEN_CHANNEL_ID,
  QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL,
  QWEN_TOKEN_PLAN_OPENAI_BASE_URL,
  canonicalModelId,
  canonicalModelKey,
  isCustomChannel,
  resolveSelectedUpstreamModelIds,
} from "../../domains/channel/types";
import {
  parseStoredLongCatPacks,
  summarizeLongCatPacks,
  type LongCatPack,
} from "./longCatPacks";
import styles from "./AccountEditorDrawer.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { useScrapeConsole } from "./useScrapeConsole";
import type { ScrapeBalanceResult } from "../../domains/account/commands";
import { formatFullTimestamp, parseTimestamp } from "../../shared/formatters/datetime";
import { formatCompactNumber } from "../../shared/formatters/number";
import {
  parseQwenTokenPlanDetails,
  type QwenQuotaWindow,
} from "./qwenTokenPlanDetails";
import {
  ACCOUNT_NAME_MAX_DISPLAY_UNITS,
  getAccountNameDisplayUnits,
  truncateAccountName,
} from "./accountName";
import { ScrapeSyncFeedback } from "./ScrapeSyncFeedback";
import { errorMessage } from "../../shared/errors/AppError";

const { Text } = Typography;

type Mode = { kind: "create"; channelId: string } | { kind: "edit"; account: ChannelAccount };
export type AccountEditorMode = Mode;
export type AccountResourceSnapshotDraft = Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">;

type TestInput = { channel_id: string; api_key: string; base_url_override?: string | null };
type ResourceDraft = { balance: string; currency: string; tokenTotal: string; tokenUsed: string; tokenRemaining: string; tokenExpire: string; tokenPacks: string };

type Props = {
  mode: Mode;
  accounts: ChannelAccount[];
  presets: ChannelPreset[];
  snapshot?: AccountBalanceSnapshot;
  onClose: () => void;
  onSave: (account: ChannelAccount, snapshot: AccountResourceSnapshotDraft | null) => Promise<void>;
  onTestConnection: (input: TestInput) => Promise<void>;
  onSyncBalance: (accountId: string) => Promise<void>;
  onScrape?: (accountId: string) => Promise<ScrapeBalanceResult>;
  /** ChatGPT 伪渠道的授权登录（浏览器 OAuth，仅新增模式）。 */
  onAuthorizeChatGpt?: () => Promise<void>;
  authorizationBusy?: boolean;
};

export function AccountEditorDrawer({ mode, accounts, presets, snapshot, onClose, onSave, onTestConnection, onSyncBalance, onScrape, onAuthorizeChatGpt, authorizationBusy = false }: Props) {
  const { language, t } = useAppPreferences();
  const [draft, setDraft] = useState<ChannelAccount>(() => createDraft(mode, accounts, presets, language));
  const [resource, setResource] = useState<ResourceDraft>(() => resourceDraft(snapshot));
  const [advancedOpen, setAdvancedOpen] = useState(
    () => mode.kind === "edit" && mode.account.channel_id === CUSTOM_CHANNEL_ID,
  );
  const [deviceOverrideEnabled, setDeviceOverrideEnabled] = useState(
    () => mode.kind === "create" || Boolean(mode.account.base_url_override || mode.account.anthropic_base_url_override),
  );
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [modelPage, setModelPage] = useState(1);
  const MODELS_PER_PAGE = 12;
  const [saving, setSaving] = useState(false);
  // 最近一次 /models 拉取返回的全量上游模型（含白名单外的）。编辑已保存账号时用
  // synced_models 预填（无 display_name），新建账号为 null 直到用户手动拉取。
  const [candidates, setCandidates] = useState<ModelSyncResult["models"] | null>(
    () => mode.kind === "edit" && mode.account.synced_models
      ? mode.account.synced_models.map((model) => ({ model }))
      : null,
  );
  const [fetchingModels, setFetchingModels] = useState(false);

  // 新增模式在渠道选择里附加 ChatGPT 伪预设（授权登录，非表单创建）。
  const allPresets = useMemo(
    () => (mode.kind === "create" ? [...presets, CHATGPT_PSEUDO_PRESET] : presets),
    [mode.kind, presets],
  );
  const channel = allPresets.find((item) => item.id === draft?.channel_id);
  const customChannel = isCustomChannel(channel);
  const isEdit = mode.kind === "edit";
  const isChatGptCreate = !isEdit && draft?.channel_id === CHATGPT_CHANNEL_ID;

  const handleAuthorizeChatGpt = async () => {
    try {
      await onAuthorizeChatGpt?.();
      Toast.success(t("ChatGPT 账号授权成功"));
      onClose();
    } catch (error) {
      Toast.error(t("ChatGPT 账号授权失败：{message}", { message: errorMessage(error) }));
    }
  };
  const autoSyncBalance = channel?.supports_balance_query === true;
  const resourceOptions = resourceModeOptions(draft?.channel_id ?? "");
  const resourceMode = draft?.resource_mode ?? defaultResourceMode(draft?.channel_id ?? "");
  // LongCat 统一为 hybrid 模式(同时抓取 token 资源包与按量余额),强制自动同步；
  const isLongCatHybrid = draft.channel_id === "longcat" && resourceMode === "hybrid";
  // Qwen Token Plan 的额度只来自官方控制台，也固定为自动同步，不再提供手动维护路径。
  const isQwenTokenPlan = draft.channel_id === QWEN_CHANNEL_ID && resourceMode === "token_plan";
  // Qwen API 按量付费账号没有官方余额接口，也没有可用的控制台抓取模式
  // （scrape 配置只针对 Token Plan 订阅端点），因此不提供自动同步，走手动维护。
  const isQwenPayAsYouGo = draft.channel_id === QWEN_CHANNEL_ID && resourceMode === "pay_as_you_go";
  const supportsScrape = channel?.supports_scrape_balance === true && !autoSyncBalance && !isQwenPayAsYouGo;
  const resourceSyncMode = isLongCatHybrid || isQwenTokenPlan ? "auto" : (draft.resource_sync_mode ?? "manual");
  const isResourceAutoSync = supportsScrape && resourceSyncMode === "auto";
  const tokenRemaining = useMemo(() => {
    const total = optionalNumber(resource.tokenTotal);
    const used = optionalNumber(resource.tokenUsed);
    return optionalNumber(resource.tokenRemaining) ?? (total != null && used != null ? Math.max(0, total - used) : snapshot?.token_pack_remaining ?? null);
  }, [resource.tokenRemaining, resource.tokenTotal, resource.tokenUsed, snapshot?.token_pack_remaining]);

  const currentDraft = draft;

  function update(patch: Partial<ChannelAccount>) {
    setDraft((current) => current ? { ...current, ...patch, updated_at: new Date().toISOString() } : current);
  }

  function selectChannel(channelId: string) {
    if (isEdit) return;
    const next = presets.find((item) => item.id === channelId);
    const count = accounts.filter((item) => item.channel_id === channelId).length;
    // 千问默认 API 按量付费（渠道级 dashscope 端点），切到 Token Plan 时由
    // selectResourceMode 写入套餐专属端点。
    const nextIsQwenTokenPlan = channelId === QWEN_CHANNEL_ID && defaultResourceMode(channelId) === "token_plan";
    update({
      channel_id: channelId,
      name: count === 0 ? t("{name} 主账号", { name: next?.name ?? t("渠道") }) : t("{name} 账号 {count}", { name: next?.name ?? t("渠道"), count: count + 1 }),
      resource_mode: defaultResourceMode(channelId),
      resource_sync_mode: channelId === "longcat" || nextIsQwenTokenPlan ? "auto" : "manual",
      base_url_override: nextIsQwenTokenPlan ? QWEN_TOKEN_PLAN_OPENAI_BASE_URL : null,
      anthropic_base_url_override: nextIsQwenTokenPlan ? QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL : null,
    });
    if (channelId === CUSTOM_CHANNEL_ID) setAdvancedOpen(true);
    setResource(resourceDraft());
  }

  /** 切换资源模式。千问支持双资源模式：Token Plan 需要配套专属端点——选入时
   *  自动写入账号级 Base URL 覆盖并强制自动同步；切回 API 按量付费时清除仍
   *  是 Token Plan 地址的覆盖（保留用户在高级设置中自定义的地址，如团队版
   *  专属 URL），并回到手动维护。 */
  function selectResourceMode(nextMode: AccountResourceMode) {
    // 账号保存后资源模式不允许切换（避免与已维护的资源数据/订阅端点冲突）。
    if (isEdit) return;
    if (currentDraft.channel_id !== QWEN_CHANNEL_ID) {
      update({ resource_mode: nextMode });
      return;
    }
    if (nextMode === "token_plan") {
      update({
        resource_mode: nextMode,
        resource_sync_mode: "auto",
        base_url_override: QWEN_TOKEN_PLAN_OPENAI_BASE_URL,
        anthropic_base_url_override: QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL,
      });
      return;
    }
    update({
      resource_mode: nextMode,
      resource_sync_mode: "manual",
      base_url_override: currentDraft.base_url_override?.trim() === QWEN_TOKEN_PLAN_OPENAI_BASE_URL ? null : currentDraft.base_url_override,
      anthropic_base_url_override: currentDraft.anthropic_base_url_override?.trim() === QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL ? null : currentDraft.anthropic_base_url_override,
    });
  }

  async function handleTest() {
    if (!currentDraft.api_key.trim()) {
      Toast.warning(t("请先填写 API Key"));
      return;
    }
    if (customChannel && !effectiveOpenAiBaseUrl(currentDraft)) {
      Toast.warning(t("测试连接需要先填写 OpenAI Base URL"));
      return;
    }
    setTesting(true);
    try {
      await onTestConnection({ channel_id: currentDraft.channel_id, api_key: currentDraft.api_key.trim(), base_url_override: effectiveOpenAiBaseUrl(currentDraft) });
      update({ credential_status: "healthy", last_error: null });
      Toast.success(t("连接成功，API Key 有效"));
    } catch (error) {
      Toast.error(t("测试连接失败：{message}", { message: toAppError(error, "account_test_failed").message }));
    } finally {
      setTesting(false);
    }
  }

  async function handleSync() {
    setSyncing(true);
    try {
      await onSyncBalance(currentDraft.id);
      Toast.success(t("余额已同步"));
    } catch (error) {
      Toast.error(t("余额同步失败：{message}", { message: toAppError(error, "account_balance_failed").message }));
    } finally {
      setSyncing(false);
    }
  }

  // 所有渠道（包括 custom）统一受 Flowlet 全局支持模型白名单保护。
  // /models 返回的白名单外模型仍展示，但禁用勾选并标记为不支持。
  const modelWhitelist = FLOWLET_SUPPORTED_MODELS;
  const whitelistSet = useMemo(
    () => new Set(modelWhitelist.map((model) => model.trim().toLowerCase())),
    [modelWhitelist],
  );

  /** 手动拉取底层 /models：用草稿当前的连接参数（故新建未保存的账号也可拉取）。
   *  全量结果进入 candidates 供展示勾选；IDs 同步写入 draft.synced_models，
   *  并清理已不在本次结果或全局白名单内的旧选择。 */
  async function handleFetchModels() {
    if (!currentDraft.api_key.trim()) {
      Toast.warning(t("请先填写 API Key"));
      return;
    }
    if (customChannel && !effectiveOpenAiBaseUrl(currentDraft)) {
      Toast.warning(t("拉取模型列表需要先填写 OpenAI Base URL"));
      return;
    }
    setFetchingModels(true);
    try {
      const result = await accountCommands.fetchChannelModels({
        channel_id: currentDraft.channel_id,
        api_key: currentDraft.api_key.trim(),
        base_url_override: effectiveOpenAiBaseUrl(currentDraft),
      });
      const models = result.models.filter((item) => item.model.trim());
      // 白名单仍按规范模型判断，但勾选值保留上游原始 ID：同一规范模型可能对应
      // 多个独立额度资源（如 deepseek-v4-flash 与 deepseek-v4-flash-0731）。
      const syncedModelIds = models.map((item) => item.model);
      setCandidates(models);
      setModelPage(1);
      update({
        synced_models: syncedModelIds,
        models_synced_at: new Date().toISOString(),
        exposed_models: currentDraft.exposed_models == null
          ? null
          : resolveSelectedUpstreamModelIds(currentDraft.exposed_models, syncedModelIds)
            .filter((model) => whitelistSet.has(canonicalModelKey(model))),
      });
      if (result.errors.length > 0) {
        Toast.warning(t("模型列表已获取，但部分请求失败：{message}", { message: result.errors[0] }));
      } else {
        Toast.success(t("已获取 {count} 个上游模型", { count: models.length }));
      }
    } catch (error) {
      Toast.error(t("拉取模型列表失败：{message}", { message: toAppError(error, "account_sync_failed").message }));
    } finally {
      setFetchingModels(false);
    }
  }

  const selectedModels = currentDraft.exposed_models ?? [];
  const candidateModelIds = useMemo(
    () => (candidates ?? []).map((candidate) => candidate.model),
    [candidates],
  );
  const selectedSet = useMemo(
    () => new Set(
      resolveSelectedUpstreamModelIds(currentDraft.exposed_models, candidateModelIds)
        .map((model) => model.toLowerCase()),
    ),
    [candidateModelIds, currentDraft.exposed_models],
  );

  /** 勾选保留 /models 返回的上游原始 ID。别名变体与规范名可能是独立额度资源，
   *  必须允许分别选择；是否受支持仍通过 canonicalModelId 按规范模型判断。 */
  function toggleExposedModel(model: string, checked: boolean) {
    if (!canonicalModelId(model)) return;
    const upstreamModel = model.trim();
    const key = upstreamModel.toLowerCase();
    const next = checked
      ? [...selectedModels.filter((item) => item.trim().toLowerCase() !== key), upstreamModel]
      : selectedModels.filter((item) => (
        !resolveSelectedUpstreamModelIds([item], candidateModelIds)
          .some((resolved) => resolved.toLowerCase() === key)
      ));
    update({ exposed_models: next });
  }

  async function handleSave() {
    const normalizedName = currentDraft.name.trim();
    if (!normalizedName || (!isEdit && !currentDraft.api_key.trim())) {
      Toast.warning(t("请填写账号名称和 API Key"));
      return;
    }
    if (
      customChannel
      && !effectiveOpenAiBaseUrl(currentDraft)
      && !(currentDraft.anthropic_base_url_override?.trim() || currentDraft.workspace_default_anthropic_base_url?.trim())
    ) {
      Toast.warning(t("自定义渠道至少需要填写一个协议的 Base URL"));
      return;
    }
    if (getAccountNameDisplayUnits(normalizedName) > ACCOUNT_NAME_MAX_DISPLAY_UNITS) {
      Toast.warning(t("账号名称最多 {max} 个字符宽度（中文按 2 个计算）", { max: ACCOUNT_NAME_MAX_DISPLAY_UNITS }));
      return;
    }
    setSaving(true);
    try {
      await onSave(
        {
          ...currentDraft,
          name: normalizedName,
          api_key: currentDraft.api_key.trim(),
          resource_sync_mode: isQwenTokenPlan || isLongCatHybrid ? "auto" : currentDraft.resource_sync_mode,
          base_url_override: currentDraft.base_url_override?.trim() || null,
          anthropic_base_url_override: currentDraft.anthropic_base_url_override?.trim() || null,
        },
        autoSyncBalance || isResourceAutoSync ? null : createSnapshotDraft(currentDraft, resource, resourceMode, tokenRemaining),
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <SideSheet
      visible
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      width={DETAIL_SHEET_WIDTH}
      title={(
        <div className={styles.title}>
          <strong>{t(isEdit ? "编辑渠道账号" : "新增渠道账号")}</strong>
          <span>{isEdit ? t("更新 {name} 的连接与资源信息", { name: draft.name }) : t("添加 {name} 账号，用于上游模型转发", { name: channel?.name ?? t("渠道") })}</span>
        </div>
      )}
      onCancel={onClose}
      footer={(
        <div className={styles.footer}>
          <Button onClick={onClose}>{t("取消")}</Button>
          {!isChatGptCreate ? (
            <Button disabled={!draft.api_key.trim()} loading={testing} onClick={() => void handleTest()}>{t("测试连接")}</Button>
          ) : null}
          {!isChatGptCreate ? (
            <Button theme="solid" type="primary" loading={saving} onClick={() => void handleSave()}>{t(isEdit ? "保存修改" : "保存账号")}</Button>
          ) : null}
        </div>
      )}
    >
      <div className={styles.content}>
        <section className={`${styles.section} ${styles.basic}`}>
          <h3>{t("基础信息")}</h3>
          {!isEdit ? (
            <div className={styles.channelRow}>
              <Field label={t("选择渠道")}>
                <Select
                  value={draft.channel_id}
                  zIndex={APP_OVERLAY_Z_INDEX.sideSheet + 1}
                  style={{ width: "100%" }}
                  onChange={(value) => selectChannel(value as string)}
                >
                  {allPresets.map((item) => (
                    <Select.Option key={item.id} value={item.id}>
                      <span className={styles.channelOptionLabel}>
                        {item.id === CUSTOM_CHANNEL_ID ? (
                          <span className={styles.customChannelIcon}>↗</span>
                        ) : item.id === CHATGPT_CHANNEL_ID ? (
                          <img src="/icons/lobe/openai.svg" alt="" className={styles.logoIcon} />
                        ) : item.id === "kimi" ? (
                          <span className={styles.kimiSwatch}><img src={`/icons/lobe/${item.id}-color.svg`} alt="" className={styles.logoIcon} /></span>
                        ) : (
                          <img src={`/icons/lobe/${item.id}-color.svg`} alt="" className={styles.logoIcon} />
                        )}
                        {item.name}
                      </span>
                    </Select.Option>
                  ))}
                </Select>
              </Field>
              <div className={styles.enabledRow}>
                <span><strong>{t("启用状态")}</strong><small>{t("停用后，该账号不会参与请求转发")}</small></span>
                <Switch aria-label={t("启用账号")} checked={draft.enabled} onChange={(checked) => update({ enabled: checked })} />
                <Text>{t(draft.enabled ? "启用" : "停用")}</Text>
              </div>
            </div>
          ) : (
            <div className={styles.enabledRow}>
              <span><strong>{t("启用状态")}</strong><small>{t("停用后，该账号不会参与请求转发")}</small></span>
              <Switch aria-label={t("启用账号")} checked={draft.enabled} onChange={(checked) => update({ enabled: checked })} />
              <Text>{t(draft.enabled ? "启用" : "停用")}</Text>
            </div>
          )}

          {isChatGptCreate ? (
            <ChatGptAuthorizePanel
              busy={authorizationBusy}
              onAuthorize={handleAuthorizeChatGpt}
            />
          ) : (
            <div className={styles.basicFields}>
              <Field label={t("账号名称")}>
                <div className={styles.nameInput}>
                  <Input aria-label={t("账号名称")} value={draft.name} onChange={(value) => update({ name: truncateAccountName(value) })} />
                  <span>{getAccountNameDisplayUnits(draft.name)} / {ACCOUNT_NAME_MAX_DISPLAY_UNITS}</span>
                </div>
              </Field>

              <Field label={(
                <span className={styles.labelRow}>API Key{channel?.platform_url ? (
                  <Text link={{ href: channel.platform_url, target: "_blank", rel: "noreferrer" }} icon={<IconExternalOpen />} size="small">{t("前往查看")}</Text>
                ) : null}</span>
              )}>
                <Input aria-label="API Key" mode="password" value={draft.api_key} placeholder={t("请输入渠道 API Key")} onChange={(value) => update({ api_key: value })} />
              </Field>
            </div>
          )}
        </section>

        {!isChatGptCreate ? (
        <section className={styles.section}>
          <div className={`${styles.sectionHeading} ${styles.resourceModeHeading}`}>
            <span><h3>{t("资源模式")}</h3><small>{t(autoSyncBalance ? "按量付费，余额自动同步" : isLongCatHybrid ? "优先使用资源包，用尽后自动扣除余额" : isQwenTokenPlan ? "订阅额度自动同步" : resourceOptions.length ? "选择资源类型以及资源信息的维护方式" : "手动维护按量付费余额")}</small></span>
            {isEdit && (resourceOptions.length || isLongCatHybrid) ? (
              <div className={styles.resourceModeMeta}>
                <span>{t("计费模式")}</span>
                <Tag color="blue">{t(resourceMode === "hybrid" ? "混合" : resourceMode === "token_pack" ? "Token 资源包" : resourceMode === "token_plan" ? "Token Plan" : "API 按量付费")}</Tag>
                <small>{t("创建后不可修改")}</small>
              </div>
            ) : null}
          </div>
          {autoSyncBalance ? (
            <div className={styles.resourcePanel}>
              <div className={styles.resourceHeading}><strong>{t("按量付费信息")}</strong><span className={styles.autoBadge}>{t("自动同步")}</span></div>
              <div className={styles.balanceRow}>
                <span>
                  <small>{t("账户余额")}</small>
                  <strong>{snapshot?.balance == null ? t("尚未同步") : `${snapshot.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${snapshot.currency ?? ""}`}</strong>
                </span>
                {isEdit ? (
                  <div className={styles.balanceActions}>
                    <Text type="tertiary" size="small">{t("最近同步：{time}", { time: snapshot?.synced_at ? formatFullTimestamp(snapshot.synced_at, language) : "-" })}</Text>
                    <Button size="small" theme="borderless" icon={<IconRefresh />} loading={syncing} onClick={() => void handleSync()}>{t("刷新")}</Button>
                  </div>
                ) : null}
              </div>
            </div>
          ) : (
            <>
              {resourceOptions.length && !isEdit ? (
                <div className={styles.modeOptions}>
                  {resourceOptions.map((option) => (
                    <ModeOption
                      key={option.value}
                      selected={resourceMode === option.value}
                      disabled={isEdit}
                      title={t(option.title)}
                      description={t(option.description)}
                      onClick={() => selectResourceMode(option.value)}
                    />
                  ))}
                </div>
              ) : null}
              {isLongCatHybrid ? (
                <LongCatTokenPackPanel
                  accountId={draft.id}
                  enabled={isEdit}
                  snapshot={snapshot}
                  onScrape={onScrape}
                  language={language}
                  t={t}
                />
              ) : isQwenTokenPlan ? (
                <QwenTokenPlanPanel
                  account={draft}
                  enabled={isEdit}
                  snapshot={snapshot}
                  onScrape={onScrape}
                  language={language}
                  t={t}
                />
              ) : (
                <div className={styles.resourcePanel}>
                <div className={styles.resourceHeading}>
                  <strong>{t(resourceMode === "token_pack" ? "资源包信息" : "按量付费信息")}</strong>
                  <span className={isResourceAutoSync ? styles.autoBadge : styles.manualBadge}>{t(isResourceAutoSync ? "自动同步" : "手动维护")}</span>
                </div>
                {supportsScrape ? (
                  <div className={styles.syncModeSection}>
                    <span className={styles.syncModeLabel}>{t("维护方式")}</span>
                    <div className={styles.modeOptions}>
                      {resourceSyncModeOptions().map((option) => (
                        <ModeOption
                          key={option.value}
                          selected={resourceSyncMode === option.value}
                          title={t(option.title)}
                          description={t(option.description)}
                          onClick={() => update({ resource_sync_mode: option.value })}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}
                {isResourceAutoSync ? (
                  <ScrapeConsolePanel
                    account={draft}
                    enabled={isEdit}
                    snapshot={snapshot}
                    onScrape={onScrape}
                    language={language}
                    t={t}
                  />
                ) : (
                  <div className={styles.resourceGrid}>
                    <Field label={t("账户余额")}><Input aria-label={t("账户余额")} type="number" value={resource.balance} onChange={(value) => setResource({ ...resource, balance: value })} placeholder={t("手动填写")} /></Field>
                    <Field label={t("货币")}><Input aria-label={t("货币")} value={resource.currency} onChange={(value) => setResource({ ...resource, currency: value })} placeholder="CNY" /></Field>
                  </div>
                )}
                </div>
              )}
            </>
          )}
        </section>
        ) : null}

        {channel?.supports_model_list ? (
          <section className={styles.section}>
            <div className={styles.modelHeading}>
              <span>
                <h3>{t("开放模型")}</h3>
                <small>{t("拉取上游模型后勾选要通过本账号开放的模型；不支持的模型不可选，一个都不选则该账号不开放任何模型")}</small>
              </span>
              <Button
                size="small"
                icon={<IconRefresh />}
                loading={fetchingModels}
                onClick={() => void handleFetchModels()}
              >
                {t("拉取模型列表")}
              </Button>
            </div>
            {candidates == null ? (
              <span className={styles.packEmpty}>{t("尚未拉取模型列表，点击“拉取模型列表”从渠道获取。")}</span>
            ) : candidates.length === 0 ? (
              <span className={styles.packEmpty}>{t("该渠道未返回任何模型。")}</span>
            ) : (
              <>
                {(() => {
                  const sorted = [...candidates].sort((a, b) => {
                    const aSupported = whitelistSet.has(canonicalModelKey(a.model));
                    const bSupported = whitelistSet.has(canonicalModelKey(b.model));
                    return Number(bSupported) - Number(aSupported);
                  });
                  const startIndex = (modelPage - 1) * MODELS_PER_PAGE;
                  const paged = sorted.slice(startIndex, startIndex + MODELS_PER_PAGE);
                  const totalPages = Math.ceil(sorted.length / MODELS_PER_PAGE);
                  return (
                    <>
                      <div className={styles.modelList}>
                        {paged.map((candidate) => {
                          // 支持与否按规范键判定；勾选状态按上游原始 ID 判定，允许
                          // 同一规范模型下的独立额度资源分别开启。
                          const key = canonicalModelKey(candidate.model);
                          const supported = whitelistSet.has(key);
                          const checked = selectedSet.has(candidate.model.trim().toLowerCase());
                          const canonical = canonicalModelId(candidate.model);
                          const isAliasVariant = supported
                            && canonical != null
                            && canonical.toLowerCase() !== candidate.model.trim().toLowerCase();
                          return (
                            <label
                              key={candidate.model}
                              className={`${styles.modelItem} ${supported ? "" : styles.modelUnsupported}`}
                            >
                              <Checkbox
                                checked={checked}
                                disabled={!supported}
                                onChange={(event) => toggleExposedModel(candidate.model, event.target.checked === true)}
                              />
                              <span className={styles.modelName}>{candidate.model}</span>
                              {isAliasVariant && canonical ? (
                                <Text type="tertiary" size="small" ellipsis={{ showTooltip: true }}>{t("开放为 {model}", { model: canonical })}</Text>
                              ) : null}
                              {candidate.display_name && candidate.display_name.trim() && candidate.display_name !== candidate.model ? (
                                <Text type="tertiary" size="small" ellipsis={{ showTooltip: true }}>{candidate.display_name}</Text>
                              ) : null}
                              {supported ? null : <Tag size="small" color="grey">{t("不支持")}</Tag>}
                            </label>
                          );
                        })}
                      </div>
                      {totalPages > 1 && (
                        <div className={styles.modelPagination}>
                          <Pagination
                            size="small"
                            total={sorted.length}
                            currentPage={modelPage}
                            pageSize={MODELS_PER_PAGE}
                            onPageChange={(page) => setModelPage(page)}
                          />
                        </div>
                      )}
                    </>
                  );
                })()}
              </>
            )}
            {draft.models_synced_at ? (
              <Text type="tertiary" size="small">{t("最近拉取：{time}", { time: formatFullTimestamp(draft.models_synced_at, language) })}</Text>
            ) : null}
          </section>
        ) : null}

        <section className={`${styles.section} ${styles.advanced}`}>
          <button type="button" className={styles.advancedToggle} onClick={() => setAdvancedOpen((value) => !value)}>
            <span><strong>{t("高级设置")}</strong><small>{t("自定义连接地址与测试账号状态")}</small></span>
            {advancedOpen ? <IconChevronUp /> : <IconChevronDown />}
          </button>
          {advancedOpen ? (
            <div className={styles.advancedContent}>
              {draft.workspace_account_id ? (
                <div className={styles.connectionScope}>
                  <div className={styles.connectionScopeHeader}>
                    <span><strong>{t("工作区默认连接")}</strong><small>{t("同步到加入该 S3 工作区的桌面设备")}</small></span>
                    <Tag color="blue" size="small">{t("工作区")}</Tag>
                  </div>
                  <div className={styles.urlGrid}>
                    <Field label={t("OpenAI Base URL（工作区默认）")}><Input aria-label={t("OpenAI Base URL（工作区默认）")} value={draft.workspace_default_base_url ?? ""} placeholder={channel?.openai_base_url || "https://example.com/v1"} onChange={(value) => update({ workspace_default_base_url: value || null })} showClear /></Field>
                    <Field label={t("Anthropic Base URL（工作区默认）")}><Input aria-label={t("Anthropic Base URL（工作区默认）")} value={draft.workspace_default_anthropic_base_url ?? ""} placeholder={channel?.anthropic_base_url || "https://example.com/anthropic"} onChange={(value) => update({ workspace_default_anthropic_base_url: value || null })} showClear /></Field>
                  </div>
                </div>
              ) : null}
              <div className={styles.connectionScope}>
                <div className={styles.connectionScopeHeader}>
                  <span><strong>{t("本设备连接")}</strong><small>{draft.workspace_account_id ? t("覆盖工作区默认地址，仅保存在当前设备") : t("当前账号的本地连接地址")}</small></span>
                  {draft.workspace_account_id ? (
                    <Switch
                      aria-label={t("使用本设备覆盖地址")}
                      checked={deviceOverrideEnabled}
                      onChange={(checked) => {
                        setDeviceOverrideEnabled(checked);
                        if (!checked) update({ base_url_override: null, anthropic_base_url_override: null });
                      }}
                    />
                  ) : null}
                </div>
                {!draft.workspace_account_id || deviceOverrideEnabled ? (
                  <div className={styles.urlGrid}>
                    <Field label={t(customChannel ? "OpenAI Base URL" : "OpenAI Base URL 覆盖（可选）")}><Input aria-label={t(customChannel ? "OpenAI Base URL" : "OpenAI Base URL 覆盖（可选）")} value={draft.base_url_override ?? ""} placeholder={draft.workspace_default_base_url || channel?.openai_base_url || "https://example.com/v1"} onChange={(value) => update({ base_url_override: value || null })} showClear /></Field>
                    <Field label={t(customChannel ? "Anthropic Base URL" : "Anthropic Base URL 覆盖（可选）")}><Input aria-label={t(customChannel ? "Anthropic Base URL" : "Anthropic Base URL 覆盖（可选）")} value={draft.anthropic_base_url_override ?? ""} placeholder={draft.workspace_default_anthropic_base_url || channel?.anthropic_base_url || "https://example.com/anthropic"} onChange={(value) => update({ anthropic_base_url_override: value || null })} showClear /></Field>
                  </div>
                ) : (
                  <Text type="tertiary" size="small">{t("当前设备使用工作区默认连接地址")}</Text>
                )}
              </div>
              <Text type="tertiary" size="small">{t(customChannel
                ? "只会为已填写 Base URL 的协议生成路由；OpenAI 使用 Bearer，Anthropic 使用 x-api-key。"
                : "填写 API Key 后可测试真实上游连接。")}</Text>
            </div>
          ) : null}
        </section>

      </div>
    </SideSheet>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div className={styles.field}><span>{label}</span>{children}</div>;
}

/** ChatGPT 伪渠道的新增面板：Codex 账号走浏览器 OAuth 授权，不填 API Key。 */
function ChatGptAuthorizePanel({ busy, onAuthorize }: { busy: boolean; onAuthorize: () => Promise<void> }) {
  const { t } = useAppPreferences();
  return (
    <div className={styles.resourcePanel}>
      <div className={styles.resourceHeading}>
        <strong>{t("ChatGPT 账号授权")}</strong>
        <span className={styles.autoBadge}>{t("浏览器授权")}</span>
      </div>
      <p className={styles.packEmpty}>
        {t("Codex 账号不是通过 API Key 创建的：点击下方按钮会在浏览器中打开 ChatGPT 授权页，授权完成后账号会自动出现在渠道账号列表。")}
      </p>
      <Button theme="solid" type="primary" loading={busy} onClick={() => void onAuthorize()}>
        {busy ? t("等待浏览器授权…") : t("授权登录")}
      </Button>
    </div>
  );
}

function ModeOption({ selected, disabled, title, description, onClick }: { selected: boolean; disabled?: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" className={`${styles.modeOption} ${selected ? styles.selected : ""}`} aria-pressed={selected} disabled={disabled} onClick={onClick}><i /><span><strong>{title}</strong><small>{description}</small></span></button>;
}

function defaultResourceMode(channelId: string): AccountResourceMode {
  if (channelId === "longcat") return "hybrid";
  if (channelId === QWEN_CHANNEL_ID) return "pay_as_you_go";
  if (channelId === CHATGPT_CHANNEL_ID) return "codex";
  return "pay_as_you_go";
}

/** 各渠道可选的资源模式。LongCat 为 hybrid(同时抓取资源包与余额),不在选择器中
 *  出现；千问支持双资源模式：API 按量付费（通用 sk- Key + 渠道级 dashscope
 *  端点）与 Token Plan 订阅（sk-sp 专属 Key + 套餐专属端点）；其余渠道只有
 *  按量付费。 */
function resourceModeOptions(channelId: string): { value: AccountResourceMode; title: string; description: string }[] {
  // LongCat 统一 hybrid,不再提供计费模式切换。
  if (channelId === "longcat") {
    return [];
  }
  // 千问双资源模式：API 按量付费 + Token Plan 订阅。
  if (channelId === QWEN_CHANNEL_ID) {
    return [
      { value: "pay_as_you_go", title: "API 按量付费", description: "通用 API Key（sk- 前缀），按用量计费" },
      { value: "token_plan", title: "Token Plan", description: "订阅套餐，sk-sp 专属 Key，按 Credits 计量" },
    ];
  }
  return [];
}

function resourceSyncModeOptions(): { value: AccountResourceSyncMode; title: string; description: string }[] {
  return [
    { value: "auto", title: "自动同步", description: "每 5 分钟从官方控制台同步，也可立即刷新" },
    { value: "manual", title: "手动维护", description: "自行添加、导入和更新资源信息" },
  ];
}

function createDraft(mode: Mode, accounts: ChannelAccount[], presets: ChannelPreset[], language: "zh-CN" | "en-US"): ChannelAccount {
  if (mode.kind === "edit") {
    const forceAutoSync = mode.account.channel_id === "longcat"
      || (mode.account.channel_id === QWEN_CHANNEL_ID && mode.account.resource_mode === "token_plan");
    return { ...mode.account, resource_sync_mode: forceAutoSync ? "auto" : mode.account.resource_sync_mode };
  }
  const channel = presets.find((item) => item.id === mode.channelId);
  const count = accounts.filter((item) => item.channel_id === mode.channelId).length;
  const now = new Date().toISOString();
  const nextQwenMode = defaultResourceMode(mode.channelId);
  // 只有默认资源模式为 Token Plan 时才预填套餐专属端点（当前默认 API 按量付费，
  // 新建账号走渠道级端点；用户切到 Token Plan 时由 selectResourceMode 补端点）。
  const qwenTokenPlanDefault = mode.channelId === QWEN_CHANNEL_ID && nextQwenMode === "token_plan";
  return {
    id: `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    workspace_account_id: null,
    channel_id: mode.channelId,
    name: language === "en-US" ? (count === 0 ? `${channel?.name ?? "Channel"} primary account` : `${channel?.name ?? "Channel"} account ${count + 1}`) : (count === 0 ? `${channel?.name ?? "渠道"} 主账号` : `${channel?.name ?? "渠道"} 账号 ${count + 1}`),
    api_key: "",
    enabled: true,
    priority: accounts.length,
    remark: "",
    resource_mode: nextQwenMode,
    resource_sync_mode: mode.channelId === "longcat" || qwenTokenPlanDefault ? "auto" : "manual",
    base_url_override: qwenTokenPlanDefault ? QWEN_TOKEN_PLAN_OPENAI_BASE_URL : null,
    anthropic_base_url_override: qwenTokenPlanDefault ? QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL : null,
    workspace_default_base_url: null,
    workspace_default_anthropic_base_url: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
    synced_models: null,
    models_synced_at: null,
    exposed_models: null,
    created_at: now,
    updated_at: now,
  };
}

function resourceDraft(snapshot?: AccountBalanceSnapshot): ResourceDraft {
  const tokenPacks = snapshot?.token_packs ?? "";
  const packExpire = summarizeLongCatPacks(parseStoredLongCatPacks(tokenPacks)).expireAt;
  return {
    balance: snapshot?.balance?.toString() ?? "",
    currency: snapshot?.currency ?? "CNY",
    tokenTotal: snapshot?.token_pack_total?.toString() ?? "",
    tokenUsed: snapshot?.token_pack_used?.toString() ?? "",
    tokenRemaining: snapshot?.token_pack_remaining?.toString() ?? "",
    tokenExpire: packExpire?.slice(0, 10) ?? snapshot?.token_pack_expire_at?.slice(0, 10) ?? "",
    tokenPacks,
  };
}

function optionalNumber(value: string): number | null {
  if (!value.trim()) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function createSnapshotDraft(account: ChannelAccount, resource: ResourceDraft, mode: AccountResourceMode, remaining: number | null): AccountResourceSnapshotDraft | null {
  // Token Plan 订阅额度只能在千问控制台查看，本地不维护快照。
  // LongCat hybrid 由控制台自动同步(资源包 + 余额),不再走手动快照路径。
  if (mode === "token_plan" || mode === "token_pack" || mode === "hybrid") return null;
  const hasValue = Boolean(resource.balance.trim());
  if (!hasValue) return null;
  return {
    account_id: account.id,
    balance: optionalNumber(resource.balance),
    currency: resource.currency.trim() || null,
    token_pack_total: null,
    token_pack_used: null,
    token_pack_remaining: null,
    token_pack_expire_at: null,
    token_packs: null,
    source: "manual",
    synced_at: new Date().toISOString(),
    remark: null,
  };
}

function LongCatTokenPackPanel({
  accountId,
  enabled,
  snapshot,
  onScrape,
  language,
  t,
}: {
  accountId: string;
  enabled: boolean;
  snapshot?: AccountBalanceSnapshot;
  onScrape?: (accountId: string) => Promise<ScrapeBalanceResult>;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const {
    startScrape,
    retryScrape,
    lastResult,
    isScraping,
    needLogin,
    consoleActionMessage,
    error,
    statusText,
  } = useScrapeConsole(onScrape);
  const freshResult = lastResult;
  const synchronizedPacks = parseStoredLongCatPacks(freshResult?.token_packs ?? snapshot?.token_packs);
  const packs = synchronizedPacks;
  const hasData = freshResult?.token_total != null
    || snapshot?.token_pack_total != null
    || packs.length > 0;
  const calculated = summarizeLongCatPacks(packs);
  const total = freshResult?.token_total
    ?? snapshot?.token_pack_total
    ?? calculated.total;
  const used = freshResult?.token_used
    ?? snapshot?.token_pack_used
    ?? calculated.used;
  const remaining = freshResult?.token_remaining
    ?? snapshot?.token_pack_remaining
    ?? calculated.remaining;
  const expireAt = freshResult?.token_pack_expire_at
    ?? snapshot?.token_pack_expire_at
    ?? calculated.expireAt;
  const syncedAt = freshResult?.synced_at ?? snapshot?.synced_at;
  const balance = freshResult?.balance ?? snapshot?.balance;
  const balanceCurrency = freshResult?.currency ?? snapshot?.currency;
  const remainingPercent = total > 0 ? Math.max(0, Math.min(100, remaining / total * 100)) : 0;
  const activeIndex = Math.max(0, packs.findIndex((pack) => (pack.consumedToken ?? 0) > 0));

  async function handleScrape() {
    if (!accountId) return;
    await startScrape(accountId);
  }

  async function handleRetry() {
    if (!accountId) return;
    await retryScrape(accountId);
  }

  return (
    <div className={styles.longCatResourcePanel}>
      <div className={styles.longCatSummaryCard}>
        <div className={styles.longCatSummaryHeading}>
          <strong>{t("资源包信息")}</strong>
          <Tag size="small" color="green">{t("自动同步")}</Tag>
        </div>
        <div className={styles.longCatSummaryGrid}>
          <div className={styles.longCatRemaining}>
            <small>{t("剩余额度")}</small>
            <strong>{hasData ? formatResourceTokenValue(remaining, language) : "-"}</strong>
          </div>
          <div className={styles.longCatProgress}>
            <strong>{hasData ? t("剩余 {percent}%", { percent: remainingPercent.toFixed(1) }) : "-"}</strong>
            <Progress aria-label={t("资源包剩余比例")} percent={remainingPercent} size="small" showInfo={false} />
            <small>{t("总量")} {hasData ? formatResourceTokenValue(total, language) : "-"}</small>
          </div>
          <div>
            <small>{t("账户余额")}</small>
            <strong>{balance == null ? "-" : `${balance} ${balanceCurrency ?? ""}`.trim()}</strong>
          </div>
          <div>
            <small>{t("最早到期")}</small>
            <strong>{expireAt?.slice(0, 10) ?? "-"}</strong>
          </div>
          <div>
            <small>{t("最近同步")}</small>
            <strong>{syncedAt ? formatLocalDate(syncedAt) : "-"}</strong>
          </div>
        </div>
      </div>

      <div className={styles.longCatSyncSection}>
        <div className={styles.longCatSyncControls}>
          <Button
            icon={<IconRefresh />}
            loading={isScraping}
            disabled={!enabled}
            onClick={() => void handleScrape()}
          >
            {t("立即刷新")}
          </Button>
          <ScrapeSyncFeedback
            isScraping={isScraping}
            statusText={statusText}
            needLogin={needLogin}
            consoleActionMessage={consoleActionMessage}
            error={error}
            onRetry={() => void handleRetry()}
            t={t}
          />
        </div>
      </div>

      <div className={styles.longCatDetails}>
        <strong>{t("资源包明细")}</strong>
        {packs.length ? (
          <div className={styles.longCatTableScroll}>
            <table className={styles.longCatTable}>
              <thead>
                <tr>
                  <th>{t("资源包 ID")}</th>
                  <th>{t("类型")}</th>
                  <th>{t("总量 Token")}</th>
                  <th>{t("已用 Token")}</th>
                  <th>{t("到期日期")}</th>
                  <th>{t("状态")}</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((pack, index) => {
                  const displayStatus = longCatPackDisplayStatus(pack, index, activeIndex, t);
                  return (
                      <tr key={pack.packageId ?? pack.lotId ?? index}>
                        <td>{pack.packageId ?? pack.lotId ?? index + 1}</td>
                      <td>{pack.packageName ?? pack.source ?? pack.grantCategory ?? pack.sourceTypeText ?? "-"}</td>
                      <td>{formatResourceTokenAmount(pack.totalToken ?? 0, language)}</td>
                      <td>{formatResourceTokenAmount(pack.consumedToken ?? 0, language)}</td>
                      <td>{pack.expireTime?.slice(0, 10) ?? "-"}</td>
                      <td><Tag size="small" color={displayStatus.color}>{displayStatus.label}</Tag></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <span className={styles.packEmpty}>{t("尚未同步资源包，请点击“立即刷新”。")}</span>
        )}
      </div>
    </div>
  );
}

function longCatPackDisplayStatus(
  pack: LongCatPack,
  index: number,
  activeIndex: number,
  t: (key: string) => string,
): { label: string; color: "green" | "orange" | "grey" } {
  const listStatusText = pack.displayStatusText ?? pack.statusText;
  const listStatusCode = pack.displayStatusCode ?? pack.statusCode;
  if (listStatusText) {
    return { label: t(listStatusText), color: listStatusCode === 1 ? "green" : "grey" };
  }
  if (listStatusCode != null && listStatusCode !== 1) {
    return { label: t("已结束"), color: "grey" };
  }
  if (pack.status && pack.status !== "ACTIVE") {
    return { label: t(pack.status), color: "grey" };
  }
  return index === activeIndex
    ? { label: t("生效中"), color: "green" }
    : { label: t("待使用"), color: "orange" };
}

/** 控制台抓取面板:触发按钮 + 最近一次抓取结果展示。 */
function ScrapeConsolePanel({
  account,
  enabled,
  snapshot,
  onScrape,
  language,
  t,
}: {
  account: ChannelAccount;
  enabled: boolean;
  snapshot?: AccountBalanceSnapshot;
  onScrape?: (accountId: string) => Promise<ScrapeBalanceResult>;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const {
    startScrape,
    retryScrape,
    lastResult,
    isScraping,
    needLogin,
    consoleActionMessage,
    error,
    statusText,
  } = useScrapeConsole(onScrape);
  async function handleScrape() {
    await startScrape(account.id);
  }

  async function handleRetry() {
    await retryScrape(account.id);
  }

  // 优先展示 hook 最近的抓取结果(ScrapeBalanceResult),否则回退到父组件传入的 snapshot
  const scrapeDisplay = lastResult;
  const fallbackDisplay = snapshot;
  return (
    <div className={styles.scrapePanel}>
      <div className={styles.scrapeToolbar}>
        <Button
          theme="solid"
          type="primary"
          size="small"
          icon={<IconRefresh />}
          loading={isScraping}
          disabled={!enabled}
          onClick={() => void handleScrape()}
        >
          {t("立即刷新")}
        </Button>
        {statusText ? <span className={styles.scrapeStatus}>{statusText}</span> : null}
      </div>
      <ScrapeSyncFeedback
        isScraping={isScraping}
        statusText={null}
        needLogin={needLogin}
        consoleActionMessage={consoleActionMessage}
        error={error}
        onRetry={() => void handleRetry()}
        t={t}
      />
      {scrapeDisplay ? (
        <div className={styles.scrapeResult}>
          {scrapeDisplay.plan_name ? <strong>{scrapeDisplay.plan_name}</strong> : null}
          {scrapeDisplay.balance != null ? (
            <span>{t("余额")} <b>{scrapeDisplay.balance} {scrapeDisplay.currency ?? ""}</b></span>
          ) : null}
          {scrapeDisplay.token_total != null ? (
            <span>{t("总额")} <b>{formatResourceTokens(scrapeDisplay.token_total, language)}</b></span>
          ) : null}
          {scrapeDisplay.token_used != null ? (
            <span>{t("已用")} <b>{formatResourceTokens(scrapeDisplay.token_used, language)}</b></span>
          ) : null}
          {scrapeDisplay.token_remaining != null ? (
            <span>{t("剩余")} <b>{formatResourceTokens(scrapeDisplay.token_remaining, language)}</b></span>
          ) : null}
          {scrapeDisplay.token_pack_expire_at ? (
            <span>{t("到期")} <b>{scrapeDisplay.token_pack_expire_at.slice(0, 10)}</b></span>
          ) : null}
          {scrapeDisplay.synced_at ? (
            <span className={styles.scrapeSynced}>{t("同步时间")} <b>{formatFullTimestamp(scrapeDisplay.synced_at, language)}</b></span>
          ) : null}
        </div>
      ) : fallbackDisplay && fallbackDisplay.source === "scrape" ? (
        <div className={styles.scrapeResult}>
          {fallbackDisplay.balance != null ? (
            <span>{t("余额")} <b>{fallbackDisplay.balance} {fallbackDisplay.currency ?? ""}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_total != null ? (
            <span>{t("总额")} <b>{formatResourceTokens(fallbackDisplay.token_pack_total, language)}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_used != null ? (
            <span>{t("已用")} <b>{formatResourceTokens(fallbackDisplay.token_pack_used, language)}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_remaining != null ? (
            <span>{t("剩余")} <b>{formatResourceTokens(fallbackDisplay.token_pack_remaining, language)}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_expire_at ? (
            <span>{t("到期")} <b>{fallbackDisplay.token_pack_expire_at.slice(0, 10)}</b></span>
          ) : null}
          {fallbackDisplay.synced_at ? (
            <span className={styles.scrapeSynced}>{t("同步时间")} <b>{formatFullTimestamp(fallbackDisplay.synced_at, language)}</b></span>
          ) : null}
        </div>
      ) : null}
      {!scrapeDisplay && !(fallbackDisplay && fallbackDisplay.source === "scrape") && !error ? (
        <span className={styles.scrapeHint}>
          {t("系统每 5 分钟自动同步一次；如登录失效，请点击“立即刷新”完成登录。")}
        </span>
      ) : null}
    </div>
  );
}

function QwenTokenPlanPanel({
  account,
  enabled,
  snapshot,
  onScrape,
  language,
  t,
}: {
  account: ChannelAccount;
  enabled: boolean;
  snapshot?: AccountBalanceSnapshot;
  onScrape?: (accountId: string) => Promise<ScrapeBalanceResult>;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const {
    startScrape,
    retryScrape,
    lastResult,
    isScraping,
    needLogin,
    consoleActionMessage,
    error,
    statusText,
  } = useScrapeConsole(onScrape);
  const details = parseQwenTokenPlanDetails(lastResult?.raw_scraped_json ?? snapshot?.raw_scraped_json);
  const syncedAt = lastResult?.synced_at ?? snapshot?.synced_at;
  const planName = details
    ? `${details.specCode.charAt(0).toUpperCase()}${details.specCode.slice(1)}`
    : "";
  const fiveHour = details?.fiveHour;
  const sevenDay = details?.sevenDay;
  const resetCards = details?.resetCards;

  async function handleScrape() {
    await startScrape(account.id);
  }

  async function handleRetry() {
    await retryScrape(account.id);
  }

  return (
    <div className={styles.longCatResourcePanel}>
      <div className={styles.longCatSummaryCard}>
        <div className={styles.longCatSummaryHeading}>
          <strong>{details ? t("个人版 {name} 套餐", { name: planName }) : t("Token Plan 订阅信息")}</strong>
          <Tag size="small" color="green">{t("自动同步")}</Tag>
        </div>
        <div className={`${styles.longCatSummaryGrid} ${styles.qwenSummaryGrid}`}>
          <QwenQuotaProgress period={t("5 小时")} quota={fiveHour} language={language} t={t} />
          <QwenQuotaProgress period={t("7 天")} quota={sevenDay} language={language} t={t} />
          <div className={styles.qwenTimeSummary}>
            <span>
              <small>{t("套餐到期")}</small>
              <strong>{details?.expireAt ? formatFullTimestamp(details.expireAt, language) : "-"}</strong>
            </span>
            <span>
              <small>{t("最近同步")}</small>
              <strong>{syncedAt ? formatFullTimestamp(syncedAt, language) : "-"}</strong>
            </span>
          </div>
        </div>
      </div>

      {resetCards ? (
        <div className={styles.qwenResetCards}>
          <div className={styles.qwenResetCardsHeader}>
            <strong>{t("重置机会")}</strong>
            <Tag color="green">{t("可用 {count} 次", { count: resetCards.available_count })}</Tag>
          </div>
          {resetCards.credits?.length ? (
            <div className={styles.qwenResetCardList}>
              {resetCards.credits.map((card) => {
                const typeLabel = card.reset_type === "RESET_1W"
                  ? t("周额度重置")
                  : card.reset_type || t("用量限额重置");
                return (
                  <div className={styles.qwenResetCard} key={card.id}>
                    <strong>{typeLabel}</strong>
                    <Text type="tertiary">
                      {typeof card.expires_at === "number"
                        ? t("将于 {time} 到期", { time: formatResetCardExpiry(card.expires_at, language) })
                        : t("未提供过期时间")}
                    </Text>
                  </div>
                );
              })}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={styles.longCatSyncSection}>
        <div className={styles.longCatSyncControls}>
          <Button
            icon={<IconRefresh />}
            loading={isScraping}
            disabled={!enabled}
            onClick={() => void handleScrape()}
          >
            {t("立即刷新")}
          </Button>
          <ScrapeSyncFeedback
            isScraping={isScraping}
            statusText={statusText}
            needLogin={needLogin}
            consoleActionMessage={consoleActionMessage}
            error={error}
            onRetry={() => void handleRetry()}
            showIdleHint={!details}
            t={t}
          />
        </div>
      </div>
    </div>
  );
}

function QwenQuotaProgress({
  period,
  quota,
  language,
  t,
}: {
  period: string;
  quota: QwenQuotaWindow | null | undefined;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const percent = quota ? Math.round(quota.remainingPercent * 10) / 10 : null;
  return (
    <div className={styles.qwenProgress}>
      <div className={styles.qwenProgressHeading}>
        <strong>
          {percent == null
            ? t("{period} -", { period })
            : t("{period} {percent}%", { period, percent: percent.toFixed(1) })}
        </strong>
        <small>{t("总量")} {quota ? formatCredits(quota.total, language) : "-"}</small>
      </div>
      <Progress
        aria-label={t("{period}额度", { period })}
        percent={percent ?? 0}
        size="small"
        showInfo={false}
      />
      <small className={styles.qwenResetTime}>
        {t("额度重置时间")} <b>{quota?.resetAt ? formatFullTimestamp(quota.resetAt, language) : "-"}</b>
      </small>
    </div>
  );
}

function formatResourceTokens(value: number | null, language: "zh-CN" | "en-US") {
  return value == null ? "-" : `${formatCompactNumber(Math.max(0, value), language)} Tokens`;
}

function formatResourceTokenValue(value: number, language: "zh-CN" | "en-US") {
  return `${formatCompactNumber(Math.max(0, value), language)} Token`;
}

function formatResourceTokenAmount(value: number, language: "zh-CN" | "en-US") {
  return formatCompactNumber(Math.max(0, value), language);
}

function formatCredits(value: number, language: "zh-CN" | "en-US") {
  return `${Math.max(0, value).toLocaleString(language, { maximumFractionDigits: 0 })} Credits`;
}

function formatLocalDate(value: string) {
  const date = parseTimestamp(value);
  if (!date) return value.slice(0, 16);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${month}月${day}日 ${hour}:${minute}`;
}

/** 重置卡到期时间的短格式（与 Codex 重置机会明细一致：月/日 + 时分）。 */
function formatResetCardExpiry(epochMs: number, language: "zh-CN" | "en-US") {
  return new Intl.DateTimeFormat(language, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(epochMs));
}
