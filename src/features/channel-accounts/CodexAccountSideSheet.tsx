import { Button, SideSheet, Typography } from "@douyinfe/semi-ui-19";
import { IconChevronRight, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
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
  /** 传入时只展示该账号；未传则展示全部账号。 */
  accountId?: string;
  accountLoading?: boolean;
  accountError?: string;
  onRefreshAccount: () => void;
  /** 单账号模式的刷新（真·单账号，仅刷新当前账号）。 */
  onRefreshAccountOne?: () => void;
  accountAuthorizationBusy?: boolean;
  onAuthorizeAccount: () => void;
  /** 单账号模式下的「全部账号」链接：清空 accountId 回到全量视图。 */
  onShowAll?: () => void;
  onClose: () => void;
  onCopy: Copy;
};

/**
 * Codex 账号与用量详情抽屉（渠道账号侧）。
 * Codex 账号由 Rust 端自动发现与同步，本机只读展示；可重新授权或刷新用量。
 * 传入 accountId 时聚焦单个账号（标题为该账号邮箱），否则展示全部账号。
 */
export function CodexAccountSideSheet({
  visible,
  accounts,
  accountId,
  accountLoading = false,
  accountError,
  onRefreshAccount,
  onRefreshAccountOne,
  accountAuthorizationBusy = false,
  onAuthorizeAccount,
  onShowAll,
  onClose,
  onCopy,
}: Props) {
  const { language, t } = useAppPreferences();
  const allAccounts = accounts?.accounts ?? [];
  const focused = accountId ? allAccounts.find((item) => item.account_id === accountId) : undefined;
  // 单账号模式：只展示当前账号；账号缺失时按空处理（避免误展示全量）。
  const visibleAccounts = accountId
    ? focused
      ? [focused]
      : []
    : allAccounts;
  const sheetTitle = t("Codex 账号与用量");
  const sectionTitle = focused ? focused.email || t("Codex 账号") : t("账号管理");

  return (
    <SideSheet
      visible={visible}
      motion={false}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      title={sheetTitle}
      width="min(760px, 96vw)"
      onCancel={onClose}
      bodyStyle={{ padding: 0 }}
    >
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{sectionTitle}</Title>
              <Text type="tertiary">{t("Codex 账号凭据仅保存在本机")}</Text>
            </div>
            <div className={styles.sectionActions}>
              {accountId ? (
                <Button theme="borderless" icon={<IconChevronRight />} onClick={onShowAll}>
                  {t("全部账号")}
                </Button>
              ) : (
                <Button
                  aria-label={t("添加 / 重新授权账号")}
                  icon={<IconPlus />}
                  loading={accountAuthorizationBusy}
                  onClick={onAuthorizeAccount}
                >
                  {accountAuthorizationBusy ? t("等待浏览器授权…") : t("添加 / 重新授权账号")}
                </Button>
              )}
              <Button
                icon={<IconRefresh />}
                loading={accountLoading}
                disabled={accountAuthorizationBusy}
                onClick={accountId ? onRefreshAccountOne : onRefreshAccount}
              >
                {t("刷新用量")}
              </Button>
            </div>
          </div>

          {accountLoading && visibleAccounts.length ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("正在刷新，当前展示上次更新的数据")}
            </Text>
          ) : null}
          {accountError && visibleAccounts.length ? (
            <Text className={styles.accountRefreshNotice} type="warning">
              {t("刷新失败，当前展示上次更新的数据：{message}", { message: accountError })}
            </Text>
          ) : null}

          {accountError && !visibleAccounts.length ? (
            <Text className={styles.environmentMessage} type="danger">
              {t("账号信息查询失败：{message}", { message: accountError })}
            </Text>
          ) : accountLoading && !accounts ? (
            <Text className={styles.environmentMessage} type="tertiary">{t("正在查询 Codex 账号与用量…")}</Text>
          ) : !visibleAccounts.length ? (
            <Text className={styles.environmentMessage} type="tertiary">{t("未检测到 Codex 登录账号")}</Text>
          ) : (
            <div className={styles.codexAccountList}>
              {visibleAccounts.map((account) => (
                <CodexAccountCard key={account.account_id} account={account} language={language} />
              ))}
            </div>
          )}
        </section>
      </div>
    </SideSheet>
  );
}
