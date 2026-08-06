import { IconChevronLeft } from "@douyinfe/semi-icons";
import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { MobileRefreshController } from "./useMobileRefreshController";
import { MobilePullToRefresh } from "./MobilePullToRefresh";
import { MobileLastRefreshTime } from "./MobileLastRefreshTime";
import styles from "./MobileSubpageShell.module.css";

/**
 * 设备二级页壳：独立页面，无底部 Tab。顶部提供返回按钮，回到设备页。
 * 会话 / Agent 二级页都复用它。单一页头（返回 + 主标题 + 描述 + 刷新时间），
 * 与其他主页面保持一致；下拉刷新包住整个页面，指示器出现在内容上方。
 */
export function MobileSubpageShell({
  title,
  description,
  refreshController,
  refreshDisabled = false,
  children,
}: {
  title: ReactNode;
  description?: ReactNode;
  refreshController?: MobileRefreshController;
  refreshDisabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useAppPreferences();
  const navigate = useNavigate();
  const disabled = refreshController?.disabled ?? true;
  return (
    <div className={styles.shell}>
      <div className={styles.frame}>
        <MobilePullToRefresh
          disabled={disabled || refreshDisabled}
          refreshing={refreshController?.loading ?? false}
          onRefresh={refreshController?.refresh ?? (async () => {})}
        >
          <div className={styles.content}>
            <header className={styles.header}>
              <button
                type="button"
                className={styles.back}
                aria-label={t("返回设备页")}
                onClick={() => navigate("/devices")}
              >
                <IconChevronLeft />
              </button>
              <div className={styles.heading}>
                <div className={styles.titleRow}>
                  <h1>{title}</h1>
                  <MobileLastRefreshTime value={refreshController?.lastSuccessAt ?? null} />
                </div>
                {description ? <p>{description}</p> : null}
              </div>
            </header>
            <div className={styles.body}>{children}</div>
          </div>
        </MobilePullToRefresh>
      </div>
    </div>
  );
}