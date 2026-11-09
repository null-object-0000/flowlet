import { useState } from "react";
import { Button, Modal, SideSheet, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
import { OverviewListRowView } from "@flowlet/product-ui";
import type { AntigravityAccountReport } from "../../domains/agent/antigravity";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { ChannelBrandLogo } from "./ChannelBrandLogo";
import styles from "./CodexAccountSideSheet.module.css";

export function AntigravityAccountRow({ account, stale, onOpen }: { account: AntigravityAccountReport; stale: boolean; onOpen: () => void }) {
  const { t } = useAppPreferences();
  const lowest = account.quotas.filter((quota) => !quota.disabled && quota.remaining_fraction !== null)
    .sort((a, b) => a.remaining_fraction! - b.remaining_fraction!)[0];
  return <OverviewListRowView
    logo={<ChannelBrandLogo channelId="antigravity" name="Antigravity" />}
    title={["Antigravity", account.email, account.plan].filter(Boolean).join(" · ")}
    subtitle={account.error ? account.error : lowest
      ? `${lowest.label} · ${t("剩余 {percent}%", { percent: Math.round(lowest.remaining_fraction! * 100) })}`
      : t("未返回可用额度数据")}
    trailing={account.reauthorization_required ? <Tag color="yellow">{t("需要重新授权")}</Tag>
      : stale || account.stale || account.error ? <Tag color="yellow">{t(account.quotas.length ? "数据同步可能已过期" : "额度不可用")}</Tag> : null}
    onClick={onOpen}
  />;
}

export function AntigravityAccountSideSheet({ accounts, accountId, loading, error, onRefresh, onClose, authorizationBusy = false, deletionBusy = false, actionError, onAuthorize, onDelete }: {
  accounts: AntigravityAccountReport[];
  accountId: string | null;
  loading: boolean;
  error?: string;
  onRefresh: () => void;
  onClose: () => void;
  authorizationBusy?: boolean;
  deletionBusy?: boolean;
  actionError?: string;
  onAuthorize?: () => void;
  onDelete?: (accountId: string) => void;
}) {
  const { t, language } = useAppPreferences();
  const [pendingDelete, setPendingDelete] = useState<AntigravityAccountReport | null>(null);
  const selected = accountId ? accounts.filter((account) => account.account_id === accountId) : accounts;
  return <SideSheet visible motion={false} title={t("Antigravity 订阅额度")} width={DETAIL_SHEET_WIDTH}
    zIndex={APP_OVERLAY_Z_INDEX.sideSheet} onCancel={onClose} bodyStyle={{ padding: 0 }}>
    <div className={styles.body}>
      <section className={styles.section}>
        <div className={styles.sectionHeader}>
          <Typography.Text type="tertiary">{t("通过 Google 授权后可独立查询额度，无需保持 Antigravity 运行。")}</Typography.Text>
          {onAuthorize ? <Button loading={authorizationBusy} disabled={deletionBusy} onClick={onAuthorize}>{authorizationBusy ? t("等待浏览器授权…") : t("授权登录")}</Button> : null}
          <Button disabled={authorizationBusy || deletionBusy} aria-label={t("刷新用量")} icon={<IconRefresh aria-hidden="true" />} loading={loading} onClick={onRefresh}>{t("刷新用量")}</Button>
        </div>
        {loading ? <Typography.Text className={styles.environmentMessage}>{t("正在查询 Antigravity 额度…")}</Typography.Text> : null}
        {actionError ? <Typography.Text type="danger" className={styles.environmentMessage}>{actionError}</Typography.Text> : null}
        {error ? <Typography.Text type="warning" className={styles.environmentMessage}>
          {t(accounts.length ? "刷新失败，当前展示上次更新的数据：{message}" : "账号信息查询失败：{message}", { message: error })}
        </Typography.Text> : null}
        {!loading && selected.length === 0 ? <Typography.Text className={styles.environmentMessage}>
          {t("尚未添加 Antigravity 授权账号。点击“授权登录”后，即使关闭 Antigravity 也能刷新额度。")}
        </Typography.Text> : null}
        <div className={styles.codexAccountList}>
          {selected.map((account) => <section key={account.account_id} className={styles.codexAccount}>
            <div className={styles.codexAccountHeader}>
              <strong>{account.email || "Antigravity"}</strong>
              <Tag>{account.source === "oauth" ? t("Google 授权") : t("本地客户端")}</Tag>
              {account.plan ? <Tag>{account.plan}</Tag> : null}
              {account.source === "oauth" && onDelete ? <Button type="danger" theme="borderless" size="small"
                disabled={authorizationBusy || deletionBusy} onClick={() => setPendingDelete(account)}>{t("移除授权")}</Button> : null}
            </div>
            <Typography.Text type="tertiary">{t("最后更新：{time}", { time: formatFullTimestamp(account.updated_at, language) })}</Typography.Text>
            {account.reauthorization_required && onAuthorize ? <Button disabled={authorizationBusy || deletionBusy} onClick={onAuthorize}>{t("重新授权")}</Button> : null}
            {account.stale && account.quotas.length > 0 ? <Typography.Text type="warning">{t("当前展示上次成功查询的数据")}</Typography.Text> : null}
            {account.error ? <Typography.Text type="warning">{account.error}</Typography.Text> : null}
            {!account.error && account.quotas.length === 0 ? <Typography.Text>{t("未返回可用额度数据")}</Typography.Text> : null}
            {account.quotas.map((quota, index) => <div className={styles.usageWindow} key={`${quota.id}-${index}`}>
              <div className={styles.usageHeader}>
                <strong>{quota.label}</strong>
                <span>{quota.disabled ? t("不可用") : quota.remaining_fraction === null ? t("额度未知")
                  : t("剩余 {percent}%", { percent: Math.round(quota.remaining_fraction * 100) })}</span>
                {quota.reset_at ? <Typography.Text type="tertiary">{t("重置时间：{time}", { time: formatFullTimestamp(quota.reset_at, language) })}</Typography.Text> : null}
              </div>
              {!quota.disabled && quota.remaining_fraction !== null ? <div className={styles.usageTrack} role="progressbar"
                aria-label={quota.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(quota.remaining_fraction * 100)}>
                <span style={{ width: `${quota.remaining_fraction * 100}%` }} />
              </div> : null}
              {quota.description ? <Typography.Text type="tertiary">{quota.description}</Typography.Text> : null}
            </div>)}
          </section>)}
        </div>
      </section>
    </div>
    <Modal title={t("移除 Antigravity 授权")} visible={pendingDelete !== null} motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.modal} onCancel={() => setPendingDelete(null)}
      okButtonProps={{ "aria-label": t("确认移除") }} cancelButtonProps={{ "aria-label": t("取消") }}
      okText={t("确认移除")} cancelText={t("取消")} confirmLoading={deletionBusy} onOk={() => {
        if (pendingDelete) onDelete?.(pendingDelete.account_id);
        setPendingDelete(null);
      }}>
      {t("将移除 Flowlet 保存的 {email} 授权和额度快照，Antigravity 客户端登录状态不受影响。", { email: pendingDelete?.email || "Antigravity" })}
    </Modal>
  </SideSheet>;
}
