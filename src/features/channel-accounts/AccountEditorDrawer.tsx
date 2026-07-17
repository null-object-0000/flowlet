import { useMemo, useState } from "react";
import { Button, Input, Select, SideSheet, Space, Switch, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronDown, IconChevronUp, IconExternalOpen, IconRefresh } from "@douyinfe/semi-icons";
import { toAppError } from "../../platform/tauri/client";
import type { AccountBalanceSnapshot, AccountResourceMode, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
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
};

export function AccountEditorDrawer({ mode, accounts, presets, snapshot, onClose, onSave, onTestConnection, onSyncBalance }: Props) {
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
  const supportsTokenPack = draft?.channel_id === "longcat";
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
          <span>{isEdit ? t("更新 {name} 的连接与资源信息", { name: draft.name }) : t("添加 LongCat、DeepSeek 或 Kimi 账号，用于上游模型转发")}</span>
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
          <div className={styles.sectionHeading}><span><h3>{t("资源模式")}</h3><small>{t(autoSyncBalance ? "按量付费，余额自动同步" : supportsTokenPack ? "保存后按所选模式维护资源信息" : "手动维护按量付费余额")}</small></span></div>
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
              {supportsTokenPack ? (
                <div className={styles.modeOptions}>
                  <ModeOption selected={resourceMode === "token_pack"} title={t("Token 资源包")} description={t("预付费，手动维护资源包信息")} onClick={() => update({ resource_mode: "token_pack" })} />
                  <ModeOption selected={resourceMode === "pay_as_you_go"} title={t("API 按量付费")} description={t("后付费，手动维护余额")} onClick={() => update({ resource_mode: "pay_as_you_go" })} />
                </div>
              ) : null}
              <div className={styles.resourcePanel}>
                <div className={styles.resourceHeading}><strong>{t(resourceMode === "token_pack" ? "资源包信息" : "按量付费信息")}</strong><span className={styles.manualBadge}>{t("手动维护")}</span></div>
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

function ModeOption({ selected, title, description, onClick }: { selected: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" className={`${styles.modeOption} ${selected ? styles.selected : ""}`} aria-pressed={selected} onClick={onClick}><i /><span><strong>{title}</strong><small>{description}</small></span></button>;
}

function defaultResourceMode(channelId: string): AccountResourceMode {
  return channelId === "longcat" ? "token_pack" : "pay_as_you_go";
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

function formatResourceTokens(value: number | null, language: "zh-CN" | "en-US") {
  return value == null ? "-" : `${formatTokenCount(Math.max(0, value), language)} Tokens`;
}
