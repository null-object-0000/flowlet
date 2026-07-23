import { useMemo, useState } from "react";
import { Button, Input, Progress, Select, SideSheet, Space, Switch, Tag, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconChevronUp, IconExternalOpen, IconRefresh } from "@douyinfe/semi-icons";
import { toAppError } from "../../platform/tauri/client";
import type { AccountBalanceSnapshot, AccountResourceMode, AccountResourceSyncMode, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import {
  QWEN_CHANNEL_ID,
  QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL,
  QWEN_TOKEN_PLAN_CONSOLE_URL,
  QWEN_TOKEN_PLAN_OPENAI_BASE_URL,
} from "../../domains/channel/types";
import {
  formatTokenCount,
  LongCatPackManager,
  parseStoredLongCatPacks,
  toLongCatPackExpireAt,
  summarizeLongCatPacks,
  type LongCatPack,
} from "./LongCatPackManager";
import styles from "./AccountEditorDrawer.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { useScrapeConsole } from "./useScrapeConsole";
import type { ScrapeBalanceResult } from "../../domains/account/commands";
import { formatFullTimestamp, parseTimestamp } from "../../shared/formatters/datetime";
import {
  parseQwenTokenPlanDetails,
  type QwenQuotaWindow,
  type QwenTokenPlanDetails,
} from "./qwenTokenPlanDetails";

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
};

export function AccountEditorDrawer({ mode, accounts, presets, snapshot, onClose, onSave, onTestConnection, onSyncBalance, onScrape }: Props) {
  const { language, t } = useAppPreferences();
  const [draft, setDraft] = useState<ChannelAccount>(() => createDraft(mode, accounts, presets, language));
  const [resource, setResource] = useState<ResourceDraft>(() => resourceDraft(snapshot));
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [testing, setTesting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [packManagerOpen, setPackManagerOpen] = useState(false);

  const channel = presets.find((item) => item.id === draft?.channel_id);
  const isEdit = mode.kind === "edit";
  const autoSyncBalance = channel?.supports_balance_query === true;
  const supportsScrape = channel?.supports_scrape_balance === true && !autoSyncBalance;
  const resourceOptions = resourceModeOptions(draft?.channel_id ?? "");
  const resourceMode = draft?.resource_mode ?? defaultResourceMode(draft?.channel_id ?? "");
  const resourceSyncMode = draft.resource_sync_mode ?? "manual";
  const isResourceAutoSync = supportsScrape && resourceSyncMode === "auto";
  const isLongCatTokenPack = draft.channel_id === "longcat" && resourceMode === "token_pack";
  const tokenRemaining = useMemo(() => {
    const total = optionalNumber(resource.tokenTotal);
    const used = optionalNumber(resource.tokenUsed);
    return optionalNumber(resource.tokenRemaining) ?? (total != null && used != null ? Math.max(0, total - used) : snapshot?.token_pack_remaining ?? null);
  }, [resource.tokenRemaining, resource.tokenTotal, resource.tokenUsed, snapshot?.token_pack_remaining]);
  const maintainedPacks = useMemo(() => parseStoredLongCatPacks(resource.tokenPacks), [resource.tokenPacks]);

  const currentDraft = draft;

  function update(patch: Partial<ChannelAccount>) {
    setDraft((current) => current ? { ...current, ...patch, updated_at: new Date().toISOString() } : current);
  }

  function selectChannel(channelId: string) {
    if (isEdit) return;
    const next = presets.find((item) => item.id === channelId);
    const count = accounts.filter((item) => item.channel_id === channelId).length;
    update({
      channel_id: channelId,
      name: count === 0 ? t("{name} 主账号", { name: next?.name ?? t("渠道") }) : t("{name} 账号 {count}", { name: next?.name ?? t("渠道"), count: count + 1 }),
      resource_mode: defaultResourceMode(channelId),
      resource_sync_mode: "manual",
      base_url_override: null,
      anthropic_base_url_override: null,
    });
    setResource(resourceDraft());
  }

  /** 切换资源模式。千问 Token Plan 需要配套专属端点：选入时自动写入
   *  账号级 Base URL 覆盖，切回按量付费时仅清除仍是 Token Plan 地址的覆盖，
   *  保留用户在高级设置中自定义的地址（如团队版专属 URL）。 */
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
        base_url_override: QWEN_TOKEN_PLAN_OPENAI_BASE_URL,
        anthropic_base_url_override: QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL,
      });
      return;
    }
    update({
      resource_mode: nextMode,
      base_url_override: currentDraft.base_url_override?.trim() === QWEN_TOKEN_PLAN_OPENAI_BASE_URL ? null : currentDraft.base_url_override,
      anthropic_base_url_override: currentDraft.anthropic_base_url_override?.trim() === QWEN_TOKEN_PLAN_ANTHROPIC_BASE_URL ? null : currentDraft.anthropic_base_url_override,
    });
  }

  async function handleTest() {
    if (!currentDraft.api_key.trim()) {
      Toast.warning(t("请先填写 API Key"));
      return;
    }
    setTesting(true);
    try {
      await onTestConnection({ channel_id: currentDraft.channel_id, api_key: currentDraft.api_key.trim(), base_url_override: currentDraft.base_url_override });
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

  async function handleSave() {
    if (!currentDraft.name.trim() || (!isEdit && !currentDraft.api_key.trim())) {
      Toast.warning(t("请填写账号名称和 API Key"));
      return;
    }
    setSaving(true);
    try {
      await onSave(
        {
          ...currentDraft,
          name: currentDraft.name.trim(),
          api_key: currentDraft.api_key.trim(),
          base_url_override: currentDraft.base_url_override?.trim() || null,
          anthropic_base_url_override: currentDraft.anthropic_base_url_override?.trim() || null,
        },
        autoSyncBalance || isResourceAutoSync ? null : createSnapshotDraft(currentDraft, resource, resourceMode, tokenRemaining),
      );
    } finally {
      setSaving(false);
    }
  }

  function handleSavePacks(packs: LongCatPack[]) {
    const summary = summarizeLongCatPacks(packs);
    setResource((current) => ({
      ...current,
      tokenTotal: String(summary.total),
      tokenUsed: String(summary.used),
      tokenRemaining: String(summary.remaining),
      tokenExpire: summary.expireAt?.slice(0, 10) ?? "",
      tokenPacks: JSON.stringify(packs),
    }));
    setPackManagerOpen(false);
  }

  return (
    <SideSheet
      visible
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      width="min(980px, 94vw)"
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
          <Button disabled={!draft.api_key.trim()} loading={testing} onClick={() => void handleTest()}>{t("测试连接")}</Button>
          <Button theme="solid" type="primary" loading={saving} onClick={() => void handleSave()}>{t(isEdit ? "保存修改" : "保存账号")}</Button>
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
                  {presets.map((item) => (
                    <Select.Option key={item.id} value={item.id}>
                      <span className={styles.channelOptionLabel}>
                        {item.id === "kimi" ? (
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

          <div className={styles.basicFields}>
            <Field label={t("账号名称")}>
              <div className={styles.nameInput}>
                <Input aria-label={t("账号名称")} maxLength={50} value={draft.name} onChange={(value) => update({ name: value })} />
                <span>{draft.name.length} / 50</span>
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
        </section>

        <section className={styles.section}>
          <div className={`${styles.sectionHeading} ${styles.resourceModeHeading}`}>
            <span><h3>{t("资源模式")}</h3><small>{t(autoSyncBalance ? "按量付费，余额自动同步" : resourceOptions.length ? "选择资源类型以及资源信息的维护方式" : "手动维护按量付费余额")}</small></span>
            {isEdit && resourceOptions.length ? (
              <div className={styles.resourceModeMeta}>
                <span>{t("计费模式")}</span>
                <Tag color="blue">{t(resourceMode === "token_pack" ? "Token 资源包" : resourceMode === "token_plan" ? "Token Plan" : "API 按量付费")}</Tag>
                <small>{t("创建后不可修改")}</small>
              </div>
            ) : null}
          </div>
          {autoSyncBalance ? (
            <div className={styles.resourcePanel}>
              <div className={styles.resourceHeading}><strong>{t("按量付费信息")}</strong><span className={styles.autoBadge}>{t("自动同步")}</span></div>
              <div className={styles.balanceRow}>
                <span><small>{t("账户余额")}</small><strong>{snapshot?.balance == null ? t("尚未同步") : `${snapshot.balance} ${snapshot.currency ?? ""}`}</strong></span>
                {isEdit ? <Button size="small" theme="borderless" icon={<IconRefresh />} loading={syncing} onClick={() => void handleSync()}>{t("刷新")}</Button> : null}
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
              {isLongCatTokenPack ? (
                <LongCatTokenPackPanel
                  accountId={draft.id}
                  enabled={isEdit}
                  syncMode={resourceSyncMode}
                  snapshot={snapshot}
                  manualPacks={maintainedPacks}
                  onSyncModeChange={(value) => update({ resource_sync_mode: value })}
                  onManage={() => setPackManagerOpen(true)}
                  onScrape={onScrape}
                  language={language}
                  t={t}
                />
              ) : (
                <div className={styles.resourcePanel}>
                <div className={styles.resourceHeading}>
                  <strong>{t(resourceMode === "token_pack" ? "资源包信息" : resourceMode === "token_plan" ? "Token Plan 订阅信息" : "按量付费信息")}</strong>
                  <span className={isResourceAutoSync ? styles.autoBadge : resourceMode === "token_plan" ? styles.planBadge : styles.manualBadge}>{t(isResourceAutoSync ? "自动同步" : resourceMode === "token_plan" ? "订阅" : "手动维护")}</span>
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
                ) : resourceMode === "token_pack" ? (
                  <div className={styles.packSection}>
                    {draft.channel_id === "longcat" ? (
                      <div className={styles.packManageRow}>
                        <Button onClick={() => setPackManagerOpen(true)}>{t("管理资源包")}</Button>
                        <span>{t("导入、添加、编辑或删除 LongCat 资源包，支持 JSON 批量导入。")}</span>
                      </div>
                    ) : null}
                    {maintainedPacks.length ? (
                      <div className={styles.packSummary}>
                        <strong>{t("已维护 {count} 个资源包", { count: maintainedPacks.length })}</strong>
                        <span>{t("总量")} <b>{formatResourceTokens(optionalNumber(resource.tokenTotal), language)}</b></span>
                        <span>{t("已消耗")} <b>{formatResourceTokens(optionalNumber(resource.tokenUsed), language)}</b></span>
                        <span>{t("剩余")} <b>{formatResourceTokens(tokenRemaining, language)}</b></span>
                        <span>{t("最早到期")} <b>{resource.tokenExpire || "-"}</b></span>
                      </div>
                    ) : <span className={styles.packEmpty}>{t("尚未维护资源包，请点击“管理资源包”添加或导入。")}</span>}
                  </div>
                ) : resourceMode === "token_plan" ? (
                  <div className={styles.tokenPlanInfo}>
                    <span>{t("Token Plan 以 Credits 统一计量，额度与剩余量请在千问 Token Plan 控制台查看。")}</span>
                    <span>{t("仅限 Claude Code、Qwen Code 等 AI 编程工具交互式使用，禁止用于自动化脚本或应用后端。")}</span>
                    <Text link={{ href: QWEN_TOKEN_PLAN_CONSOLE_URL, target: "_blank", rel: "noreferrer" }} icon={<IconExternalOpen />} size="small">{t("打开 Token Plan 控制台")}</Text>
                  </div>
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

        <section className={`${styles.section} ${styles.advanced}`}>
          <button type="button" className={styles.advancedToggle} onClick={() => setAdvancedOpen((value) => !value)}>
            <span><strong>{t("高级设置")}</strong><small>{t("自定义连接地址与测试账号状态")}</small></span>
            {advancedOpen ? <IconChevronUp /> : <IconChevronDown />}
          </button>
          {advancedOpen ? (
            <div className={styles.advancedContent}>
              <div className={styles.urlGrid}>
                <Field label={t("OpenAI Base URL 覆盖（可选）")}><Input aria-label={t("OpenAI Base URL 覆盖（可选）")} value={draft.base_url_override ?? ""} placeholder={channel?.openai_base_url} onChange={(value) => update({ base_url_override: value || null })} showClear /></Field>
                <Field label={t("Anthropic Base URL 覆盖（可选）")}><Input aria-label={t("Anthropic Base URL 覆盖（可选）")} value={draft.anthropic_base_url_override ?? ""} placeholder={channel?.anthropic_base_url} onChange={(value) => update({ anthropic_base_url_override: value || null })} showClear /></Field>
              </div>
              <Text type="tertiary" size="small">{t("填写 API Key 后可测试真实上游连接。")}</Text>
            </div>
          ) : null}
        </section>

      </div>
      {packManagerOpen ? (
        <LongCatPackManager
          initialPacks={maintainedPacks}
          onCancel={() => setPackManagerOpen(false)}
          onSave={handleSavePacks}
        />
      ) : null}
    </SideSheet>
  );
}

function Field({ label, children }: { label: React.ReactNode; children: React.ReactNode }) {
  return <div className={styles.field}><span>{label}</span>{children}</div>;
}

function ModeOption({ selected, disabled, title, description, onClick }: { selected: boolean; disabled?: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" className={`${styles.modeOption} ${selected ? styles.selected : ""}`} aria-pressed={selected} disabled={disabled} onClick={onClick}><i /><span><strong>{title}</strong><small>{description}</small></span></button>;
}

function defaultResourceMode(channelId: string): AccountResourceMode {
  return channelId === "longcat" ? "token_pack" : "pay_as_you_go";
}

/** 各渠道可选的资源模式。LongCat 支持 Token 资源包；千问支持 Token Plan
 *  订阅（专属 sk-sp Key 与套餐端点）；其余渠道只有按量付费。 */
function resourceModeOptions(channelId: string): { value: AccountResourceMode; title: string; description: string }[] {
  if (channelId === "longcat") {
    return [
      { value: "token_pack", title: "Token 资源包", description: "预付费，维护资源包余量与有效期" },
      { value: "pay_as_you_go", title: "API 按量付费", description: "后付费，手动维护余额" },
    ];
  }
  if (channelId === QWEN_CHANNEL_ID) {
    return [
      { value: "pay_as_you_go", title: "API 按量付费", description: "后付费，手动维护余额" },
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
  if (mode.kind === "edit") return { ...mode.account };
  const channel = presets.find((item) => item.id === mode.channelId);
  const count = accounts.filter((item) => item.channel_id === mode.channelId).length;
  const now = new Date().toISOString();
  return {
    id: `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel_id: mode.channelId,
    name: language === "en-US" ? (count === 0 ? `${channel?.name ?? "Channel"} primary account` : `${channel?.name ?? "Channel"} account ${count + 1}`) : (count === 0 ? `${channel?.name ?? "渠道"} 主账号` : `${channel?.name ?? "渠道"} 账号 ${count + 1}`),
    api_key: "",
    enabled: true,
    priority: accounts.length,
    remark: "",
    resource_mode: defaultResourceMode(mode.channelId),
    resource_sync_mode: "manual",
    base_url_override: null,
    anthropic_base_url_override: null,
    last_used_at: null,
    last_error: null,
    credential_status: "healthy",
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
  if (mode === "token_plan") return null;
  const hasValue = mode === "token_pack"
    ? Boolean(resource.tokenTotal.trim() || resource.tokenUsed.trim() || resource.tokenExpire.trim() || resource.tokenPacks.trim())
    : Boolean(resource.balance.trim());
  if (!hasValue) return null;
  return {
    account_id: account.id,
    balance: mode === "pay_as_you_go" ? optionalNumber(resource.balance) : null,
    currency: mode === "pay_as_you_go" ? resource.currency.trim() || null : null,
    token_pack_total: mode === "token_pack" ? optionalNumber(resource.tokenTotal) : null,
    token_pack_used: mode === "token_pack" ? optionalNumber(resource.tokenUsed) : null,
    token_pack_remaining: mode === "token_pack" ? remaining : null,
    token_pack_expire_at: mode === "token_pack" ? toLongCatPackExpireAt(resource.tokenExpire) : null,
    token_packs: mode === "token_pack" && resource.tokenPacks ? resource.tokenPacks : null,
    source: "manual",
    synced_at: new Date().toISOString(),
    remark: null,
  };
}

function LongCatTokenPackPanel({
  accountId,
  enabled,
  syncMode,
  snapshot,
  manualPacks,
  onSyncModeChange,
  onManage,
  onScrape,
  language,
  t,
}: {
  accountId: string;
  enabled: boolean;
  syncMode: AccountResourceSyncMode;
  snapshot?: AccountBalanceSnapshot;
  manualPacks: LongCatPack[];
  onSyncModeChange: (value: AccountResourceSyncMode) => void;
  onManage: () => void;
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
  const freshResult = syncMode === "auto" ? lastResult : null;
  const synchronizedPacks = parseStoredLongCatPacks(freshResult?.token_packs ?? snapshot?.token_packs);
  const packs = syncMode === "manual" ? manualPacks : synchronizedPacks;
  const hasData = freshResult?.token_total != null
    || snapshot?.token_pack_total != null
    || packs.length > 0;
  const calculated = summarizeLongCatPacks(packs);
  const total = freshResult?.token_total
    ?? (syncMode === "manual" ? calculated.total : snapshot?.token_pack_total)
    ?? calculated.total;
  const used = freshResult?.token_used
    ?? (syncMode === "manual" ? calculated.used : snapshot?.token_pack_used)
    ?? calculated.used;
  const remaining = freshResult?.token_remaining
    ?? (syncMode === "manual" ? calculated.remaining : snapshot?.token_pack_remaining)
    ?? calculated.remaining;
  const expireAt = freshResult?.token_pack_expire_at
    ?? (syncMode === "manual" ? calculated.expireAt : snapshot?.token_pack_expire_at)
    ?? calculated.expireAt;
  const syncedAt = freshResult?.synced_at ?? snapshot?.synced_at;
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
          <Tag size="small" color={syncMode === "auto" ? "green" : "orange"}>{t(syncMode === "auto" ? "自动同步" : "手动维护")}</Tag>
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
        <strong>{t("同步方式")}</strong>
        <div className={styles.longCatSyncControls}>
          <div className={styles.modeOptions}>
            <ModeOption
              selected={syncMode === "auto"}
              title={t("自动同步")}
              description={t("从 LongCat 定期同步资源包数据")}
              onClick={() => onSyncModeChange("auto")}
            />
            <ModeOption
              selected={syncMode === "manual"}
              title={t("手动维护")}
              description={t("手动导入或维护资源包数据")}
              onClick={() => onSyncModeChange("manual")}
            />
          </div>
          {syncMode === "auto" ? (
            <Button
              icon={<IconRefresh />}
              loading={isScraping}
              disabled={!enabled}
              onClick={() => void handleScrape()}
            >
              {t("立即刷新")}
            </Button>
          ) : (
            <Button onClick={onManage}>{t("管理资源包")}</Button>
          )}
        </div>
        {statusText ? <span className={styles.scrapeStatus}>{statusText}</span> : null}
        {needLogin ? (
          <div className={styles.scrapeError}>
            {t("检测到控制台登录页，请在弹出的窗口中完成登录。")}
            <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={() => void handleRetry()}>
              {t("登录完成,重新抓取")}
            </Button>
          </div>
        ) : null}
        {consoleActionMessage ? (
          <div className={styles.scrapeError}>
            {consoleActionMessage}
            <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={() => void handleRetry()}>
              {t("重新抓取")}
            </Button>
          </div>
        ) : null}
        {error ? <div className={styles.scrapeError}>{t("抓取失败：{message}", { message: error })}</div> : null}
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
                  <th>{t("总量")}</th>
                  <th>{t("已用")}</th>
                  <th>{t("到期日期")}</th>
                  <th>{t("状态")}</th>
                </tr>
              </thead>
              <tbody>
                {packs.map((pack, index) => {
                  const displayStatus = longCatPackDisplayStatus(pack, index, activeIndex, t);
                  return (
                    <tr key={pack.lotId ?? index}>
                      <td>{pack.lotId ?? index + 1}</td>
                      <td>{pack.source ?? pack.grantCategory ?? "-"}</td>
                      <td>{formatResourceTokenValue(pack.totalToken ?? 0, language)}</td>
                      <td>{formatResourceTokenValue(pack.consumedToken ?? 0, language)}</td>
                      <td>{pack.expireTime?.slice(0, 10) ?? "-"}</td>
                      <td><Tag size="small" color={displayStatus.color}>{displayStatus.label}</Tag></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <span className={styles.packEmpty}>{t(syncMode === "auto" ? "尚未同步资源包，请点击“立即刷新”。" : "尚未维护资源包，请点击“管理资源包”添加或导入。")}</span>
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
  const qwenDetails = account.channel_id === QWEN_CHANNEL_ID
    ? parseQwenTokenPlanDetails(scrapeDisplay?.raw_scraped_json ?? fallbackDisplay?.raw_scraped_json)
    : null;

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
      {needLogin ? (
        <div className={styles.scrapeError}>
          {t("检测到控制台登录页，请在弹出的窗口中完成登录。")}
          <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={() => void handleRetry()}>
            {t("登录完成,重新抓取")}
          </Button>
        </div>
      ) : null}
      {consoleActionMessage ? (
        <div className={styles.scrapeError}>
          {consoleActionMessage}
          <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={() => void handleRetry()}>
            {t("重新抓取")}
          </Button>
        </div>
      ) : null}
      {error ? <div className={styles.scrapeError}>{t("抓取失败：{message}", { message: error })}</div> : null}
      {scrapeDisplay ? (
        <div className={styles.scrapeResult}>
          {!qwenDetails && scrapeDisplay.plan_name ? <strong>{scrapeDisplay.plan_name}</strong> : null}
          {scrapeDisplay.balance != null ? (
            <span>{t("余额")} <b>{scrapeDisplay.balance} {scrapeDisplay.currency ?? ""}</b></span>
          ) : null}
          {!qwenDetails && scrapeDisplay.token_total != null ? (
            <span>{t("总额")} <b>{formatResourceTokens(scrapeDisplay.token_total, language)}</b></span>
          ) : null}
          {!qwenDetails && scrapeDisplay.token_used != null ? (
            <span>{t("已用")} <b>{formatResourceTokens(scrapeDisplay.token_used, language)}</b></span>
          ) : null}
          {!qwenDetails && scrapeDisplay.token_remaining != null ? (
            <span>{t("剩余")} <b>{formatResourceTokens(scrapeDisplay.token_remaining, language)}</b></span>
          ) : null}
          {!qwenDetails && scrapeDisplay.token_pack_expire_at ? (
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
          {!qwenDetails && fallbackDisplay.token_pack_total != null ? (
            <span>{t("总额")} <b>{formatResourceTokens(fallbackDisplay.token_pack_total, language)}</b></span>
          ) : null}
          {!qwenDetails && fallbackDisplay.token_pack_used != null ? (
            <span>{t("已用")} <b>{formatResourceTokens(fallbackDisplay.token_pack_used, language)}</b></span>
          ) : null}
          {!qwenDetails && fallbackDisplay.token_pack_remaining != null ? (
            <span>{t("剩余")} <b>{formatResourceTokens(fallbackDisplay.token_pack_remaining, language)}</b></span>
          ) : null}
          {!qwenDetails && fallbackDisplay.token_pack_expire_at ? (
            <span>{t("到期")} <b>{fallbackDisplay.token_pack_expire_at.slice(0, 10)}</b></span>
          ) : null}
          {fallbackDisplay.synced_at ? (
            <span className={styles.scrapeSynced}>{t("同步时间")} <b>{formatFullTimestamp(fallbackDisplay.synced_at, language)}</b></span>
          ) : null}
        </div>
      ) : null}
      {qwenDetails ? (
        <QwenTokenPlanDetailsPanel details={qwenDetails} language={language} t={t} />
      ) : null}
      {!scrapeDisplay && !(fallbackDisplay && fallbackDisplay.source === "scrape") && !error ? (
        <span className={styles.scrapeHint}>
          {t("系统每 5 分钟自动同步一次；如登录失效，请点击“立即刷新”完成登录。")}
        </span>
      ) : null}
    </div>
  );
}

function QwenTokenPlanDetailsPanel({
  details,
  language,
  t,
}: {
  details: QwenTokenPlanDetails;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const planName = `${details.specCode.charAt(0).toUpperCase()}${details.specCode.slice(1)}`;
  const valid = details.status === "VALID";
  return (
    <div className={styles.qwenPlanDetails}>
      <div className={styles.qwenPlanHeading}>
        <strong>{t("个人版 {name} 套餐", { name: planName })}</strong>
        {details.status ? <Tag size="small" color={valid ? "green" : "orange"}>{t(valid ? "生效中" : details.status)}</Tag> : null}
      </div>
      <div className={styles.qwenSubscriptionGrid}>
        <QwenInfo label={t("自动续费")} value={details.autoRenew == null ? "-" : t(details.autoRenew ? "已开启" : "已关闭")} />
        <QwenInfo label={t("剩余天数")} value={details.remainingDays == null ? "-" : t("{count} 天", { count: details.remainingDays })} />
        <QwenInfo label={t("到期时间")} value={details.expireAt ? formatFullTimestamp(details.expireAt, language) : "-"} />
      </div>
      <div className={styles.qwenQuotaGrid}>
        <QwenQuotaCard title={t("每 5 小时额度")} quota={details.fiveHour} language={language} t={t} />
        <QwenQuotaCard title={t("每 7 天额度")} quota={details.sevenDay} language={language} t={t} />
      </div>
    </div>
  );
}

function QwenInfo({ label, value }: { label: string; value: string }) {
  return <span><small>{label}</small><b>{value}</b></span>;
}

function QwenQuotaCard({
  title,
  quota,
  language,
  t,
}: {
  title: string;
  quota: QwenQuotaWindow | null;
  language: "zh-CN" | "en-US";
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  if (!quota) return null;
  const percent = Math.round(quota.remainingPercent * 10) / 10;
  return (
    <section className={styles.qwenQuotaCard}>
      <div className={styles.qwenQuotaHeading}>
        <strong>{title}</strong>
        <b>{percent.toFixed(1)}%</b>
      </div>
      <Progress aria-label={`${title} ${t("剩余")}`} percent={percent} size="small" showInfo={false} />
      <div className={styles.qwenQuotaMetrics}>
        <QwenInfo label={t("剩余额度")} value={formatCredits(quota.remaining, language)} />
        <QwenInfo label={t("已使用")} value={formatCredits(quota.used, language)} />
        <QwenInfo label={t("总额度")} value={formatCredits(quota.total, language)} />
      </div>
      <span className={styles.qwenResetTime}>
        {t("额度重置时间")} <b>{quota.resetAt ? formatFullTimestamp(quota.resetAt, language) : "-"}</b>
      </span>
    </section>
  );
}

function formatResourceTokens(value: number | null, language: "zh-CN" | "en-US") {
  return value == null ? "-" : `${formatTokenCount(Math.max(0, value), language)} Tokens`;
}

function formatResourceTokenValue(value: number, language: "zh-CN" | "en-US") {
  return `${formatTokenCount(Math.max(0, value), language)} Token`;
}

function formatLocalDate(value: string) {
  const date = parseTimestamp(value);
  if (!date) return value.slice(0, 10);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatCredits(value: number, language: "zh-CN" | "en-US") {
  return `${Math.max(0, value).toLocaleString(language, { maximumFractionDigits: 0 })} Credits`;
}
