import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { useMobileAccountResources } from "../../features/device-sync/useMobileDeviceSync";
import { MobileAccountResourceList } from "../MobileAccountResourceList";
import { MobileSubpageShell } from "../MobileSubpageShell";
import { useMobileRefreshController } from "../useMobileRefreshController";
import styles from "../MobileAccountResources.module.css";

export function MobileAccountResourcesPage() {
  const { t } = useAppPreferences();
  const resources = useMobileAccountResources();
  const refreshController = useMobileRefreshController();
  return <MobileSubpageShell
    title={t("账号资源")}
    description={t("查看工作区内支持自动同步的账号用量、额度与余额")}
    refreshController={refreshController}
    backTo="/"
    backLabel="返回概览页"
  >
    {resources.isLoading ? <div className={styles.empty}>{t("正在读取账号资源…")}</div> : null}
    {resources.isError ? <div className={styles.empty}>{t("账号资源加载失败：{message}", { message: resources.error.message })}</div> : null}
    {!resources.isLoading && !resources.isError && (resources.data?.length ?? 0) === 0 ? <div className={styles.empty}>{t("暂无可查看账号。仅展示已加入账号工作区且支持桌面端自动同步的账号资源。")}</div> : null}
    <MobileAccountResourceList resources={resources.data ?? []} />
  </MobileSubpageShell>;
}
