import { useMemo } from "react";
import { Button, Modal, Space, Toast, Typography } from "@douyinfe/semi-ui-19";
import type { AccountBalanceResult, AccountBalanceSnapshot, ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import { CHATGPT_CHANNEL_ID } from "../../domains/channel/types";
import type { ScrapeBalanceResult } from "../../domains/account/commands";
import { AccountEditorDrawer, type AccountEditorMode, type AccountResourceSnapshotDraft } from "./AccountEditorDrawer";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";

const { Text } = Typography;

export type AccountActionRequest =
  | { kind: "create"; channelId: string }
  | { kind: "edit"; accountId: string }
  | { kind: "delete"; accountId: string };

type TestInput = { channel_id: string; api_key: string; base_url_override?: string | null };
type Props = {
  request: AccountActionRequest | null;
  accounts: ChannelAccount[];
  snapshots: AccountBalanceSnapshot[];
  presets: ChannelPreset[];
  busy: boolean;
  onClose: () => void;
  onSaveAccounts: (accounts: ChannelAccount[]) => Promise<void>;
  onTestConnection: (input: TestInput) => Promise<void>;
  onSaveBalanceSnapshot: (snapshot: AccountBalanceSnapshot) => Promise<void>;
  onSyncBalance: (accountId: string) => Promise<AccountBalanceResult | void>;
  onScrape: (accountId: string) => Promise<ScrapeBalanceResult>;
  onAuthorizeChatGpt?: () => Promise<void>;
  authorizationBusy?: boolean;
};

/**
 * 概览页账号操作的轻量弹层控制器。
 * 只承载新增/编辑抽屉与删除确认，不再提供第二套账号列表管理界面。
 */
export function AccountActionOverlay(props: Props) {
  const { t } = useAppPreferences();
  const {
    request,
    accounts,
    snapshots,
    presets,
    busy,
    onClose,
    onSaveAccounts,
    onTestConnection,
    onSaveBalanceSnapshot,
    onSyncBalance,
    onScrape,
    onAuthorizeChatGpt,
    authorizationBusy = false,
  } = props;
  const snapshotByAccount = useMemo(
    () => new Map(snapshots.map((item) => [item.account_id, item])),
    [snapshots],
  );
  const activeEditor = resolveRequestedEditor(request, accounts, presets);
  const deleteTarget = request?.kind === "delete"
    ? accounts.find((item) => item.id === request.accountId) ?? null
    : null;

  const saveEditor = async (account: ChannelAccount, snapshot: AccountResourceSnapshotDraft | null) => {
    const previous = accounts.find((item) => item.id === account.id);
    const normalized = previous && !account.api_key.trim() ? { ...account, api_key: previous.api_key } : account;
    const nextAccounts = previous
      ? accounts.map((item) => item.id === normalized.id ? normalized : item)
      : [...accounts, normalized];
    try {
      await onSaveAccounts(nextAccounts);
      if (snapshot) {
        const now = new Date().toISOString();
        await onSaveBalanceSnapshot({
          ...snapshot,
          id: `snapshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          created_at: now,
          updated_at: now,
        });
      }
      Toast.success(t("渠道账号与资源信息已保存，代理配置已热更新"));
      onClose();
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  const remove = async () => {
    if (!deleteTarget) return;
    try {
      await onSaveAccounts(accounts.filter((item) => item.id !== deleteTarget.id));
      Toast.success(t("账号已删除"));
      onClose();
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <>
      {activeEditor ? <AccountEditorDrawer
        key={activeEditor.kind === "create" ? `create:${activeEditor.channelId}` : `edit:${activeEditor.account.id}`}
        mode={activeEditor}
        accounts={accounts}
        presets={presets}
        snapshot={activeEditor.kind === "edit" ? snapshotByAccount.get(activeEditor.account.id) : undefined}
        onClose={onClose}
        onSave={saveEditor}
        onTestConnection={onTestConnection}
        onSyncBalance={onSyncBalance}
        onScrape={onScrape}
        onAuthorizeChatGpt={onAuthorizeChatGpt}
        authorizationBusy={authorizationBusy}
      /> : null}
      <Modal
        title={t("确认删除账号")}
        visible={deleteTarget != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        footer={null}
        onCancel={onClose}
      >
        <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
          <Text>{t("确定要删除账号“{name}”吗？删除后将退出所有路由，且无法恢复。", { name: deleteTarget?.name ?? "" })}</Text>
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={onClose}>{t("取消")}</Button>
            <Button type="danger" theme="solid" loading={busy} onClick={() => void remove()}>{t("确认删除")}</Button>
          </Space>
        </Space>
      </Modal>
    </>
  );
}

function resolveRequestedEditor(
  request: AccountActionRequest | null,
  accounts: ChannelAccount[],
  presets: ChannelPreset[],
): AccountEditorMode | null {
  if (!request || request.kind === "delete") return null;
  if (request.kind === "create") {
    if (request.channelId === CHATGPT_CHANNEL_ID) {
      return { kind: "create", channelId: CHATGPT_CHANNEL_ID };
    }
    return presets.some((item) => item.id === request.channelId)
      ? { kind: "create", channelId: request.channelId }
      : null;
  }
  const account = accounts.find((item) => item.id === request.accountId);
  return account ? { kind: "edit", account } : null;
}
