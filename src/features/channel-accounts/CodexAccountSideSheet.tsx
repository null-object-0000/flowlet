import { Button, SideSheet, Typography } from "@douyinfe/semi-ui-19";
import { IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import type { CodexAccountReport, CodexAccountsReport } from "../../domains/agent/types";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { CodexAccountCard } from "./CodexAccountCard";
import styles from "./CodexAccountSideSheet.module.css";

const { Text, Title } = Typography;
type Copy = (value: string, message: string) => Promise<void>;

type Props = {
  visible: boolean;
  accounts?: CodexAccountsReport;
  accountLoading?: boolean;
  accountError?: string;
  onRefreshAccount: () => void;
  accountAuthorizationBusy?: boolean;
  onAuthorizeAccount: () => void;
  onClose: () => void;
  onCopy: Copy;
};

/**
 * Codex 账号与用量详情抽屉（渠道账号侧）。
 * Codex 账号由 Rust 端自动发现与同步，本机只读展示；可重新授权或刷新用量。
 */
export function CodexAccountSideSheet({
  visible,
  accounts,
  accountLoading = false,
  accountError,
  onRefreshAccount,
  accountAuthorizationBusy = false,
  onAuthorizeAccount,
  onClose,
  onCopy,
}: Props) {
  const { t } = useAppPreferences();

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={t("Codex 账号与用量")}
      width="min(760px, 96vw)"
      onCancel={onClose}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("账号管理")}</Title>
              <Text type="tertiary">{t("Codex 账号凭据仅保存在本机")}</Text>
            </div>
            <div className={styles.sectionActions}>
              <Button
                aria-label={t("添加 / 重新授权账号")}
                icon={<IconPlus />}
                loading={accountAuthorizationBusy}
                onClick={onAuthorizeAccount}
              >
                {accountAuthorizationBusy ? t("等待浏览器授权…") : t("添加 / 重新授权账号")}
              </Button>
              <Button icon={<IconRefresh />} loading={accountLoading} disabled={accountAuthorizationBusy} onClick={onRefreshAccount}>
                {t("刷新用量")}
              </Button>
            </div>
          </div>

          {accountLoading && accounts?.accounts.length ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("正在刷新，当前展示上次更新的数据")}
            </Text>
          ) : null}
          {accountError && accounts?.accounts.length ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("刷新失败，当前展示上次更新的数据：{message}", { message: accountError })}
            </Text>
          ) : null}

          {accountError && !accounts?.accounts.length ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("账号信息查询失败：{message}", { message: accountError })}
            </Text>
          ) : accountLoading && !accounts ? (
            <Text className={styles.environmentMessage} type="tertiary">{t("正在查询 Codex 账号与用量…")}</Text>
          ) : !accounts?.accounts.length ? (
            <Text className={styles.environmentMessage} type="tertiary">{t("未检测到 Codex 登录账号")}</Text>
          ) : (
            <div className={styles.codexAccountList}>
              {accounts.accounts.map((account) => (
                <CodexAccountCard key={account.account_id} account={account} language={useAppPreferences().language} />
              ))}
            </div>
          )}
        </section>
      </div>
    </SideSheet>
  );
}
