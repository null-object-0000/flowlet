import { Button, SideSheet, Typography } from "@douyinfe/semi-ui-19";
import { IconRefresh } from "@douyinfe/semi-icons";
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
  onClose: () => void;
};

/**
 * Codex 单账号详情抽屉。账号入口位于概览页渠道账号卡片，不再提供独立的账号列表页。
 * 账号凭据只读展示；刷新用量和重新授权均在此处完成。
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
  onClose,
}: Props) {
  const { language, t } = useAppPreferences();
  const account = accounts?.accounts.find((item) => item.account_id === accountId);
  const authorizationExpired = account ? isCodexAuthorizationExpired(account) : false;

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
    </SideSheet>
  );
}
