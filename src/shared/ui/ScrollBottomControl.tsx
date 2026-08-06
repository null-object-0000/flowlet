import { Button } from "@douyinfe/semi-ui-19";
import { IconChevronDown } from "@douyinfe/semi-icons";
import styles from "./ScrollBottomControl.module.css";

/**
 * 右下角「滚动到底部」悬浮按钮：用户不在会话内容底部时出现，
 * 有新内容到达时通过右上角红点提示。与移动端会话弹窗的滚动控件一致。
 */
export function ScrollBottomControl({
  hasUnseenContent,
  ariaLabel,
  onClick,
}: {
  hasUnseenContent: boolean;
  ariaLabel: string;
  onClick: () => void;
}) {
  return (
    <div className={styles.control} data-unseen-content={hasUnseenContent || undefined}>
      <Button
        type="primary"
        theme="solid"
        icon={<IconChevronDown />}
        aria-label={ariaLabel}
        title={ariaLabel}
        onClick={onClick}
      />
    </div>
  );
}
