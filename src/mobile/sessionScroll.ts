export const SESSION_BOTTOM_FOLLOW_THRESHOLD_PX = 32;

type ScrollContainer = Pick<HTMLElement, "clientHeight" | "scrollHeight" | "scrollTop">;

/** 距底部很近时仍视为用户正在跟随最新内容，吸收移动端滚动误差。 */
export function isSessionScrollNearBottom(container: ScrollContainer) {
  return container.scrollHeight - container.scrollTop - container.clientHeight
    <= SESSION_BOTTOM_FOLLOW_THRESHOLD_PX;
}

/** 仅在刷新前已经位于底部时跟随新内容，避免打断用户查看历史。 */
export function followSessionScrollBottom(container: ScrollContainer, shouldFollow: boolean) {
  if (!shouldFollow) return false;
  container.scrollTop = container.scrollHeight;
  return true;
}
