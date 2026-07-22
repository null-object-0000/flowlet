import { useMemo, useState } from "react";
import { Button, Input, Select, SideSheet, Space, Switch, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconChevronUp, IconExternalOpen, IconRefresh } from "@douyinfe/semi-icons";
import { toAppError } from "../../platform/tauri/client";
import type { AccountBalanceSnapshot, AccountResourceMode, ChannelAccount } from "../../domains/account/types";
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
  onScrape?: (accountId: string) => Promise<void>;
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
        autoSyncBalance ? null : createSnapshotDraft(currentDraft, resource, resourceMode, tokenRemaining),
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
      width="min(760px, 94vw)"
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
          <div className={styles.sectionHeading}><span><h3>{t("资源模式")}</h3><small>{t(autoSyncBalance ? "按量付费，余额自动同步" : resourceOptions.length ? "保存后按所选模式维护资源信息" : "手动维护按量付费余额")}</small></span></div>
          {autoSyncBalance ? (
            <div className={styles.resourcePanel}>
              <div className={styles.resourceHeading}><strong>{t("按量付费信息")}</strong><span className={styles.autoBadge}>{t("自动同步")}</span></div>
              <div className={styles.balanceRow}>
                <span><small>{t("账户余额")}</small><strong>{snapshot?.balance == null ? t("尚未同步") : `${snapshot.balance} ${snapshot.currency ?? ""}`}</strong></span>
                {isEdit ? <Button size="small" theme="borderless" icon={<IconRefresh />} loading={syncing} onClick={() => void handleSync()}>{t("刷新")}</Button> : null}
              </div>
            </div>
          ) : supportsScrape ? (
            <div className={styles.resourcePanel}>
              <div className={styles.resourceHeading}>
                <strong>{t("控制台抓取")}</strong>
                <span className={styles.manualBadge}>{t("手动触发")}</span>
              </div>
              <ScrapeConsolePanel
                account={draft}
                snapshot={snapshot}
                onScrape={onScrape}
                t={t}
              />
            </div>
          ) : (
            <>
              {resourceOptions.length ? (
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
              <div className={styles.resourcePanel}>
                <div className={styles.resourceHeading}>
                  <strong>{t(resourceMode === "token_pack" ? "资源包信息" : resourceMode === "token_plan" ? "Token Plan 订阅信息" : "按量付费信息")}</strong>
                  <span className={resourceMode === "token_plan" ? styles.planBadge : styles.manualBadge}>{t(resourceMode === "token_plan" ? "订阅" : "手动维护")}</span>
                </div>
                {resourceMode === "token_pack" ? (
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
      { value: "token_pack", title: "Token 资源包", description: "预付费，手动维护资源包信息" },
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

/** 控制台抓取面板:触发按钮 + 最近一次抓取结果展示。 */
function ScrapeConsolePanel({
  account,
  snapshot,
  onScrape,
  t,
}: {
  account: ChannelAccount;
  snapshot?: AccountBalanceSnapshot;
  onScrape?: (accountId: string) => Promise<void>;
  t: (k: string, params?: Record<string, string | number> | undefined) => string;
}) {
  const { startScrape, retryScrape, lastResult, isScraping, needLogin, error, statusText } = useScrapeConsole();
  const isEdit = Boolean(account.id);

  async function handleScrape() {
    if (onScrape) {
      // onScrape 直接调 scrapeBalance mutation,绕过 hook 的 startScrape。
      // 需要自行捕获错误并转为 UI 可见的 Toast/状态,避免静默失败。
      // 注意:错误可能是 AppError 对象({code, message})而非 Error 实例,
      // 直接取 message 属性,避免 String(err) 得到 "[object Object]"。
      try {
        await onScrape(account.id);
      } catch (err) {
        const message = err && typeof err === "object" && "message" in err
          ? String((err as { message: unknown }).message)
          : err instanceof Error ? err.message : String(err);
        Toast.error(t("抓取失败：{message}", { message }));
      }
      return;
    }
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
          disabled={!isEdit}
          onClick={() => void handleScrape()}
        >
          {t("登录控制台抓取")}
        </Button>
        {statusText ? <span className={styles.scrapeStatus}>{statusText}</span> : null}
      </div>
      {needLogin ? (
        <div className={styles.scrapeError}>
          {t("未登录官方控制台,请在弹出的窗口中完成登录。")}
          <Button size="small" theme="solid" type="primary" loading={isScraping} onClick={() => void handleRetry()}>
            {t("登录完成,重新抓取")}
          </Button>
        </div>
      ) : null}
      {error ? <div className={styles.scrapeError}>{t("抓取失败：{message}", { message: error })}</div> : null}
      {scrapeDisplay ? (
        <div className={styles.scrapeResult}>
          {scrapeDisplay.plan_name ? <strong>{scrapeDisplay.plan_name}</strong> : null}
          {scrapeDisplay.balance != null ? (
            <span>{t("余额")} <b>{scrapeDisplay.balance} {scrapeDisplay.currency ?? ""}</b></span>
          ) : null}
          {scrapeDisplay.token_total != null ? (
            <span>{t("总额")} <b>{formatResourceTokens(scrapeDisplay.token_total, "zh-CN")}</b></span>
          ) : null}
          {scrapeDisplay.token_used != null ? (
            <span>{t("已用")} <b>{formatResourceTokens(scrapeDisplay.token_used, "zh-CN")}</b></span>
          ) : null}
          {scrapeDisplay.token_remaining != null ? (
            <span>{t("剩余")} <b>{formatResourceTokens(scrapeDisplay.token_remaining, "zh-CN")}</b></span>
          ) : null}
          {scrapeDisplay.token_pack_expire_at ? (
            <span>{t("到期")} <b>{scrapeDisplay.token_pack_expire_at.slice(0, 10)}</b></span>
          ) : null}
          {scrapeDisplay.synced_at ? (
            <span className={styles.scrapeSynced}>{t("同步时间")} <b>{scrapeDisplay.synced_at.slice(0, 19).replace("T", " ")}</b></span>
          ) : null}
        </div>
      ) : fallbackDisplay && fallbackDisplay.source === "scrape" ? (
        <div className={styles.scrapeResult}>
          {fallbackDisplay.balance != null ? (
            <span>{t("余额")} <b>{fallbackDisplay.balance} {fallbackDisplay.currency ?? ""}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_total != null ? (
            <span>{t("总额")} <b>{formatResourceTokens(fallbackDisplay.token_pack_total, "zh-CN")}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_used != null ? (
            <span>{t("已用")} <b>{formatResourceTokens(fallbackDisplay.token_pack_used, "zh-CN")}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_remaining != null ? (
            <span>{t("剩余")} <b>{formatResourceTokens(fallbackDisplay.token_pack_remaining, "zh-CN")}</b></span>
          ) : null}
          {fallbackDisplay.token_pack_expire_at ? (
            <span>{t("到期")} <b>{fallbackDisplay.token_pack_expire_at.slice(0, 10)}</b></span>
          ) : null}
          {fallbackDisplay.synced_at ? (
            <span className={styles.scrapeSynced}>{t("同步时间")} <b>{fallbackDisplay.synced_at.slice(0, 19).replace("T", " ")}</b></span>
          ) : null}
        </div>
      ) : null}
      {!scrapeDisplay && !(fallbackDisplay && fallbackDisplay.source === "scrape") && !error ? (
        <span className={styles.scrapeHint}>
          {t("点击上方按钮登录官方控制台,自动抓取套餐余量。抓取前请确认浏览器已登录该渠道。")}
        </span>
      ) : null}
    </div>
  );
}

function formatResourceTokens(value: number | null, language: "zh-CN" | "en-US") {
  return value == null ? "-" : `${formatTokenCount(Math.max(0, value), language)} Tokens`;
}
