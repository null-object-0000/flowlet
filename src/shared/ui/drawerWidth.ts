// 桌面端详情抽屉统一宽度：随窗口大小动态缩放。
// 基准：窗口 1200px 时抽屉 760px（比例 760 : 1200 = 19 : 30）；
// 窗口小于等于基准时抽屉固定 760px 不缩小，窗口大于基准时抽屉按窗口等比放大。
export const DETAIL_SHEET_WIDTH = "max(760px, calc(100vw * 19 / 30))";

/** 会话的对话/轨迹双栏需要更宽的可视区域；仍保留窗口边缘用于关闭和拖动。 */
export const SESSION_DETAIL_SHEET_WIDTH = "min(1080px, calc(100vw - 24px))";
