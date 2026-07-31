import { MarkdownRender } from "@douyinfe/semi-ui-19";
import type { CSSProperties, ReactNode } from "react";
import styles from "./Markdown.module.css";

function MarkdownLink({ children, ...props }: { children?: ReactNode; href?: string }) {
  return <a {...props} target="_blank" rel="noreferrer">{children}</a>;
}

/** 只读 Markdown 渲染（Agent 输入输出消息等不可信内容）。
 *  format="md"：按纯 Markdown 解析，无需转义 `{` `<`，原始 HTML 会被剥离，避免 XSS。 */
export function Markdown({
  content,
  className,
  style,
}: {
  content: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <MarkdownRender
      className={className ? `${styles.markdown} ${className}` : styles.markdown}
      style={style}
      format="md"
      raw={content}
      components={{ a: MarkdownLink }}
    />
  );
}
