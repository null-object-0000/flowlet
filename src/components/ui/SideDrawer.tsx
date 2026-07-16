import React from "react";
import { Drawer } from "@mantine/core";
import css from "./SideDrawer.module.css";

type SideDrawerProps = {
  opened: boolean;
  onClose: () => void;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  /** 默认 right。覆盖位置以复用为其他方向的弹窗。 */
  position?: "right" | "left" | "top" | "bottom";
  /** Mantine Drawer size prop. 默认 min(760px, 94vw). */
  size?: string;
  /** 弹窗底部操作区（取消/确认等按钮组）。 */
  footer?: React.ReactNode;
  /** body 内容区是否可滚动。默认 true（内容超出会 sticky footer + 滚动 body）。 */
  scrollable?: boolean;
  children: React.ReactNode;
};

/**
 * 统一右侧抽屉壳，收归右侧抽屉共用的 header / body / footer 结构。
 *
 * 替代给 Mantine Drawer classNames 塞 helper class（detail-drawer-header、
 * account-management-header 等）再由 ui.css / features.css 全局赋 padding 的做法：
 * 头/身/底样式全部收进 CSS Module，避免全局规则优先级冲突和 HMR 缓存失效。
 */
export function SideDrawer({
  opened,
  onClose,
  title,
  subtitle,
  position = "right",
  size = "min(760px, 94vw)",
  footer,
  scrollable = true,
  children,
}: SideDrawerProps) {
  return (
    <Drawer
      opened={opened}
      onClose={onClose}
      position={position}
      size={size}
      padding={0}
      zIndex={2000}
      withCloseButton={false}
      classNames={{ root: css.drawer, header: css.header, body: css.body }}
    >
      <header className={css.headerInner}>
        <div className={css.titleWrap}>
          <h2 className={css.title}>{title}</h2>
          {subtitle ? <span className={css.subtitle}>{subtitle}</span> : null}
        </div>
      </header>

      {scrollable ? (
        <>
          <div className={css.bodyInner}>{children}</div>
          {footer ? <div className={css.footer}>{footer}</div> : null}
        </>
      ) : (
        <>
          {children}
          {footer ? <div className={css.footer}>{footer}</div> : null}
        </>
      )}
    </Drawer>
  );
}
