import React from "react";
import { ActionIcon, Badge, Button, Drawer, Group, Switch, Text, TextInput, Modal, Stack } from "@mantine/core";
import { IconDotsVertical, IconPlayerPause, IconPlayerPlay, IconPlus, IconSearch, IconTrash } from "@tabler/icons-react";
import { notifications } from "@mantine/notifications";
import { AccountBalanceSnapshot, ChannelAccount, ChannelPreset } from "../../domain";
import { ChannelLogo } from "../../components/ChannelLogo";
import { AccountEditorRequest } from "./AccountEditorDrawer";
import { formatTokenCount } from "./LongCatPackImportDialog";

type AccountManagementDrawerProps = {
  opened: boolean;
  onClose: () => void;
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  onSaveAccounts: (accounts: ChannelAccount[]) => Promise<void> | void;
  onTestConnection: (channelId: string, apiKey: string, baseUrlOverride?: string | null) => void;
  onSyncBalance: (accountId: string) => void;
  getBalanceForAccount: (accountId: string) => AccountBalanceSnapshot | undefined;
  onAddBalanceSnapshot: (snapshot: Omit<AccountBalanceSnapshot, "id" | "created_at" | "updated_at">) => void;
  onOpenEditor: (request: AccountEditorRequest) => void;
};

function accountStatus(account: ChannelAccount): { label: string; color: "green" | "red" | "gray" } {
  if (!account.enabled) return { label: "已停用", color: "gray" };
  if (account.credential_status === "invalid_key") return { label: "API Key 无效", color: "red" };
  return { label: "正常", color: "green" };
}

function resourceSummary(account: ChannelAccount, snapshot?: AccountBalanceSnapshot): Array<{ label: string; value: string }> {
  const resourceMode = account.resource_mode ?? (account.channel_id === "longcat" ? "token_pack" : "pay_as_you_go");
  if (resourceMode === "token_pack") {
    const items: Array<{ label: string; value: string }> = [
      { label: "剩余", value: snapshot ? `${formatTokenCount(snapshot.token_pack_remaining)} Tokens` : "-" },
    ];
    if (snapshot?.token_pack_expire_at) {
      items.push({ label: "有效期", value: snapshot.token_pack_expire_at.split("T")[0] });
    }
    return items;
  }
  const items: Array<{ label: string; value: string }> = [
    { label: "余额", value: snapshot?.balance != null ? `${snapshot.balance} ${snapshot.currency ?? ""}`.trim() : "-" },
  ];
  return items;
}

export function AccountManagementDrawer({
  opened,
  onClose,
  accounts,
  channels,
  onSaveAccounts,
  onSyncBalance,
  getBalanceForAccount,
  onAddBalanceSnapshot,
  onOpenEditor,
}: AccountManagementDrawerProps) {
  const [search, setSearch] = React.useState("");
  const [confirmDeleteIndex, setConfirmDeleteIndex] = React.useState<number | null>(null);

  // 每次关闭时清空搜索
  React.useEffect(() => {
    if (!opened) setSearch("");
  }, [opened]);

  const enabledAccounts = accounts.filter((account) => account.enabled).length;

  const filteredAccounts = React.useMemo(() => {
    const keyword = search.trim().toLowerCase();
    return accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => {
        const channel = channels.find((item) => item.id === account.channel_id);
        return !keyword
          || account.name.toLowerCase().includes(keyword)
          || channel?.name.toLowerCase().includes(keyword)
          || account.channel_id.toLowerCase().includes(keyword);
      });
  }, [accounts, channels, search]);

  function toggleEnabled(indexInList: number, enabled: boolean) {
    const targetIndex = filteredAccounts[indexInList]?.index;
    if (targetIndex == null) return;
    const nextAccounts = accounts.map((account, idx) => (idx === targetIndex ? { ...account, enabled } : account));
    void onSaveAccounts(nextAccounts);
  }

  function openDeleteConfirm(indexInList: number) {
    const targetIndex = filteredAccounts[indexInList]?.index;
    if (targetIndex == null) return;
    setConfirmDeleteIndex(targetIndex);
  }

  async function confirmDelete() {
    if (confirmDeleteIndex == null) return;
    const nextAccounts = accounts.filter((_, idx) => idx !== confirmDeleteIndex);
    setConfirmDeleteIndex(null);
    await onSaveAccounts(nextAccounts);
    notifications.show({ message: "账号已删除", color: "green" });
  }

  function editAccount(indexInList: number) {
    const targetIndex = filteredAccounts[indexInList]?.index;
    if (targetIndex == null) return;
    onOpenEditor({ mode: "edit", index: targetIndex });
  }

  const confirmAccount = confirmDeleteIndex != null ? accounts[confirmDeleteIndex] : null;

  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position="right"
      size="min(680px, 92vw)"
      padding={0}
      zIndex={2000}
      classNames={{
        root: "account-management-drawer",
        header: "account-management-header",
        body: "account-management-body",
        title: "account-management-title",
      }}
      title={
        <div>
          <strong>渠道账号管理</strong>
          <span>共 {accounts.length} 个账号，{enabledAccounts} 个已启用</span>
        </div>
      }
    >
      <div className="account-management-content">
        <div className="account-management-toolbar">
          <TextInput
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索账号名称或渠道"
            leftSection={<IconSearch size={15} />}
            aria-label="搜索账号"
          />
          <span className="account-management-total">共 {filteredAccounts.length} 条</span>
        </div>

        <div className="account-management-tablist">
          {accounts.length === 0 ? (
            <div className="account-management-empty">
              <IconDotsVertical size={28} stroke={1.4} />
              <Text c="dimmed" size="sm">还没有配置渠道账号，点击右上方「新增账号」开始添加。</Text>
            </div>
          ) : filteredAccounts.length === 0 ? (
            <div className="account-management-empty">
              <IconSearch size={28} stroke={1.4} />
              <Text c="dimmed" size="sm">没有匹配「{search}」的账号</Text>
            </div>
          ) : (
            <div className="account-management-table">
              {filteredAccounts.map(({ account, index }, listIndex) => {
                const channel = channels.find((item) => item.id === account.channel_id);
                const snapshot = getBalanceForAccount(account.id);
                const status = accountStatus(account);
                const resources = resourceSummary(account, snapshot);
                return (
                  <div className="account-management-row" key={account.id}>
                    <button
                      type="button"
                      className="account-management-row-main"
                      onClick={() => editAccount(listIndex)}
                      aria-label={`编辑账号 ${account.name}`}
                    >
                      <ChannelLogo channelId={account.channel_id} channelName={channel?.name} size={32} variant="avatar" />
                      <div className="account-management-row-text">
                        <strong>{account.name}</strong>
                        <span>{channel?.name ?? account.channel_id}</span>
                      </div>
                      <div className="account-management-row-metrics  ">
                        {resources.map((item) => (
                          <span className="account-metric" key={item.label}>
                            <em>{item.label}</em>
                            <b>{item.value}</b>
                          </span>
                        ))}
                      </div>
                    </button>
                    <Group gap="xs" className="account-management-row-actions">
                      <Badge variant="light" color={status.color} size="sm">
                        {status.label}
                      </Badge>
                      <Switch
                        checked={account.enabled}
                        size="sm"
                        onLabel={<IconPlayerPlay size={10} />}
                        offLabel={<IconPlayerPause size={10} />}
                        onChange={(event) => toggleEnabled(listIndex, event.currentTarget.checked)}
                      />
                      <ActionIcon variant="subtle" size="md" onClick={() => editAccount(listIndex)} aria-label="编辑账号">
                        <IconDotsVertical size={17} />
                      </ActionIcon>
                      <ActionIcon variant="subtle" size="md" color="red" onClick={() => openDeleteConfirm(listIndex)} aria-label="删除账号">
                        <IconTrash size={16} />
                      </ActionIcon>
                    </Group>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <footer className="account-management-footer">
        <Button variant="default" onClick={onClose}>关闭</Button>
        <Button
          leftSection={<IconPlus size={15} />}
          onClick={() => onOpenEditor({ mode: "create", channelId: channels[0]?.id ?? "longcat" })}
        >
          新增账号
        </Button>
      </footer>

      <Modal
        opened={confirmAccount != null}
        onClose={() => setConfirmDeleteIndex(null)}
        title="确认删除账号"
        size="sm"
        zIndex={2100}
        centered
      >
        <Stack gap="md">
          <Text size="sm">
            确定要删除账号「{confirmAccount?.name}」吗？删除后将退出所有路由，且无法恢复。
          </Text>
          <Group justify="flex-end">
            <Button variant="subtle" onClick={() => setConfirmDeleteIndex(null)}>取消</Button>
            <Button color="red" onClick={() => void confirmDelete()}>确认删除</Button>
          </Group>
        </Stack>
      </Modal>
    </Drawer>
  );
}
