import { useState } from "react";
import { Button, Modal, SideSheet, Space, Typography } from "@douyinfe/semi-ui-19";
import { IconDelete, IconRefresh } from "@douyinfe/semi-icons";
import type { CodexAccountsReport } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { CodexAccountEditor, isCodexAuthorizationExpired } from "./CodexAccountEditor";
import styles from "./CodexAccountSideSheet.module.css";

const { Text, Title } = Typography;

type Props = {
  visible: boolean;
  accounts?: CodexAccountsReport;
  accountId: string;
  accountLoading?: boolean;
  accountError?: string;
  onRefreshAccount: () => void;
  accountAuthorizationBusy?: boolean;
  onAuthorizeAccount: () => void;
  onDeleteAccount: () => void;
  accountDeletionBusy?: boolean;
  onClose: () => void;
};

/**
 * Codex 单账号详情抽屉。账号入口位于概览页渠道账号卡片，不再提供独立的账号列表页。
 * 账号凭据只读展示；刷新用量、重新授权和删除均在此处完成。
 */
export function CodexAccountSideSheet({
  visible,
  accounts,
  accountId,
  accountLoading = false,
  accountError,
  onRefreshAccount,
  accountAuthorizationBusy = false,
  onAuthorizeAccount,
  onDeleteAccount,
  accountDeletionBusy = false,
  onClose,
}: Props) {
  const { language, t } = useAppPreferences();
  const account = accounts?.accounts.find((item) => item.account_id === accountId);
  const authorizationExpired = account ? isCodexAuthorizationExpired(account) : false;
  const [confirmDeleteVisible, setConfirmDeleteVisible] = useState(false);
  const busy = accountLoading || accountAuthorizationBusy || accountDeletionBusy;

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={t("Codex 账号详情")}
      width={DETAIL_SHEET_WIDTH}
      onCancel={onClose}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div className={styles.sectionHeading}>
              <Title heading={5}>{account?.email || t("Codex 账号")}</Title>
              <Text type="tertiary">{t("Codex 账号凭据仅保存在本机")}</Text>
            </div>
            <div className={styles.sectionActions}>
              <Button
                type={authorizationExpired ? "primary" : "tertiary"}
                loading={accountAuthorizationBusy}
                disabled={accountLoading}
                onClick={onAuthorizeAccount}
              >
                {accountAuthorizationBusy ? t("等待浏览器授权…") : t("重新授权")}
              </Button>
              <Button
                icon={<IconRefresh />}
                loading={accountLoading}
                disabled={accountAuthorizationBusy}
                onClick={onRefreshAccount}
              >
                {t("刷新用量")}
              </Button>
              <Button
                type="danger"
                theme="borderless"
                icon={<IconDelete />}
                aria-label={t("删除账号")}
                disabled={!account || busy}
                onClick={() => setConfirmDeleteVisible(true)}
              />
            </div>
          </div>

          {accountLoading && account ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("正在刷新，当前展示上次更新的数据")}
            </Text>
          ) : null}
          {accountError && account ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("刷新失败，当前展示上次更新的数据：{message}", { message: accountError })}
            </Text>
          ) : null}

          {accountError && !account ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("账号信息查询失败：{message}", { message: accountError })}
            </Text>
          ) : accountLoading && !accounts ? (
            <Text className={styles.environmentMessage} type="tertiary">
              {t("正在查询 Codex 账号与用量…")}
            </Text>
          ) : !account ? (
            <Text className={styles.environmentMessage} type="tertiary">
              {t("未找到此 Codex 账号")}
            </Text>
          ) : (
            <CodexAccountEditor account={account} language={language} />
          )}
        </section>
      </div>

      <Modal
        title={t("确认删除 Codex 账号")}
        visible={confirmDeleteVisible}
        motion={false}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        footer={null}
        // Semi Modal 默认 body 底部内边距为 0（content 垂直 padding 也为 0），
        // 不加这一行按钮会直接贴到弹窗底部边缘。
        bodyStyle={{ paddingBottom: 16 }}
        onCancel={() => setConfirmDeleteVisible(false)}
      >
        <Space vertical align="start" spacing="loose" style={{ width: "100%" }}>
          <Text>
            {t(
              "确定要删除 Codex 账号“{name}”吗？删除后将移除 Flowlet 保存在本机的该账号凭据与用量快照，并停止用量同步。Codex 端登录状态不受影响；若该账号仍是 Codex 当前登录账号，同步后会重新出现。",
              { name: account?.email || account?.account_id || t("Codex 账号") },
            )}
          </Text>
          <Space style={{ justifyContent: "flex-end", width: "100%" }}>
            <Button onClick={() => setConfirmDeleteVisible(false)}>{t("取消")}</Button>
            <Button
              type="danger"
              theme="solid"
              loading={accountDeletionBusy}
              onClick={() => {
                setConfirmDeleteVisible(false);
                onDeleteAccount();
              }}
            >
              {t("确认删除")}
            </Button>
          </Space>
        </Space>
      </Modal>
    </SideSheet>
  );
}
