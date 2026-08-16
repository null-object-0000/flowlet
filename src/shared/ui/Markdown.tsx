import { Fragment, createElement, useMemo } from "react";
import type { CSSProperties, Key, ReactNode } from "react";
import katex from "katex";
import "katex/dist/katex.min.css";
import type * as Md from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { mathFromMarkdown } from "mdast-util-math";
import { gfm } from "micromark-extension-gfm";
import { math } from "micromark-extension-math";
import { normalizeUri } from "micromark-util-sanitize-uri";

import styles from "./Markdown.module.css";
import { MarkdownCodeBlock } from "./MarkdownCodeBlock";

type ReferenceTargets = Map<string, Md.Definition>;
type FootnoteDefinitionNode = {
  type: "footnoteDefinition";
  identifier: string;
  label?: string | null;
  children: Md.RootContent[];
};
type FootnoteDefinitions = Map<string, FootnoteDefinitionNode>;

function safeUrl(url: string): string | undefined {
  try {
    const normalized = normalizeUri(url);
    const protocol = new URL(normalized).protocol;
    return protocol === "http:" || protocol === "https:" || protocol === "mailto:"
      ? normalized
      : undefined;
  } catch {
    return undefined;
  }
}

/** 官方 MarkdownText 的三臂渲染：严格 → strict:ignore → 红色错误 span。 */
function renderMath(value: string, displayMode: boolean): string {
  try {
    return katex.renderToString(value, { displayMode, throwOnError: true });
  } catch {
    try {
      return katex.renderToString(value, { displayMode, strict: "ignore", throwOnError: false });
    } catch {
      return `<span class="katex-error" style="color:#cc0000">${escapeHtml(value)}</span>`;
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderLink(href: string, children: ReactNode[], key: Key): ReactNode {
  const safeHref = safeUrl(href);
  if (!safeHref) return <Fragment key={key}>{children}</Fragment>;
  const external = safeHref.startsWith("http://") || safeHref.startsWith("https://");
  return <a key={key} href={safeHref} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>{children}</a>;
}

function renderChildren(nodes: readonly Md.RootContent[], definitions: ReferenceTargets): ReactNode[] {
  return nodes.map((node, index) => renderNode(node, index, definitions));
}

function renderListItem(item: Md.ListItem, loose: boolean, key: Key, definitions: ReferenceTargets): ReactNode {
  const task = typeof item.checked === "boolean";
  return (
    <li key={key} className={task ? styles.taskListItem : undefined}>
      {item.children.map((child, index) => {
        const rendered = child.type === "paragraph" ? renderChildren(child.children, definitions) : renderNode(child, index, definitions);
        const body = task && index === 0
          ? <><input type="checkbox" checked={item.checked === true} disabled />{rendered}</>
          : rendered;
        return child.type === "paragraph" && !loose
          ? <Fragment key={index}>{body}</Fragment>
          : <Fragment key={index}>{child.type === "paragraph" ? <p>{body}</p> : body}</Fragment>;
      })}
    </li>
  );
}

function renderList(node: Md.List, key: Key, definitions: ReferenceTargets): ReactNode {
  const loose = Boolean(node.spread) || node.children.some((item) => Boolean(item.spread) || item.children.length > 1);
  const props: { key: Key; start?: number; className?: string } = { key };
  if (node.ordered && typeof node.start === "number" && node.start !== 1) props.start = node.start;
  if (node.children.some((item) => typeof item.checked === "boolean")) props.className = styles.taskList;
  return createElement(node.ordered ? "ol" : "ul", props, ...node.children.map((item, index) => renderListItem(item, loose, index, definitions)));
}

function renderTable(node: Md.Table, key: Key, definitions: ReferenceTargets): ReactNode {
  const [head, ...body] = node.children;
  const row = (value: Md.TableRow, cell: "th" | "td", rowKey: Key) => (
    <tr key={rowKey}>
      {value.children.map((entry, index) => createElement(
        cell,
        { key: index, style: node.align?.[index] ? { textAlign: node.align[index] } : undefined },
        ...renderChildren(entry.children, definitions),
      ))}
    </tr>
  );
  return (
    <div key={key} className={styles.tableScroll}>
      <table>
        {head ? <thead>{row(head, "th", "head")}</thead> : null}
        {body.length ? <tbody>{body.map((entry, index) => row(entry, "td", index))}</tbody> : null}
      </table>
    </div>
  );
}

function renderImage(url: string, alt: string, key: Key): ReactNode {
  const src = safeUrl(url);
  if (!src || src.startsWith("mailto:")) return <span key={key} className={styles.imageAlt}>{alt}</span>;
  return <img key={key} className={styles.image} src={src} alt={alt} loading="lazy" decoding="async" referrerPolicy="no-referrer" />;
}

function renderNode(node: Md.RootContent, key: Key, definitions: ReferenceTargets): ReactNode {
  switch (node.type) {
    case "text": return node.value;
    case "paragraph": return <p key={key}>{renderChildren(node.children, definitions)}</p>;
    case "heading": return createElement(`h${node.depth}`, { key }, ...renderChildren(node.children, definitions));
    case "blockquote": return <blockquote key={key}>{renderChildren(node.children, definitions)}</blockquote>;
    case "thematicBreak": return <hr key={key} />;
    case "break": return <Fragment key={key}><br />{"\n"}</Fragment>;
    case "strong": return <strong key={key}>{renderChildren(node.children, definitions)}</strong>;
    case "emphasis": return <em key={key}>{renderChildren(node.children, definitions)}</em>;
    case "delete": return <del key={key}>{renderChildren(node.children, definitions)}</del>;
    case "inlineCode": return <code key={key}>{node.value.replace(/\r?\n|\r/g, " ")}</code>;
    case "html": return node.value;
    case "code": return <MarkdownCodeBlock key={key} code={node.value} language={node.lang ?? undefined} />;
    case "list": return renderList(node, key, definitions);
    case "listItem": return renderListItem(node, Boolean(node.spread), key, definitions);
    case "table": return renderTable(node, key, definitions);
    case "link": return renderLink(node.url, renderChildren(node.children, definitions), key);
    case "linkReference": {
      const target = definitions.get(node.identifier.toUpperCase());
      const children = renderChildren(node.children, definitions);
      return target ? renderLink(target.url, children, key) : <Fragment key={key}>{children}</Fragment>;
    }
    case "image": return renderImage(node.url, node.alt ?? "", key);
    case "imageReference": {
      const target = definitions.get(node.identifier.toUpperCase());
      return target ? renderImage(target.url, node.alt ?? "", key) : node.alt ?? "";
    }
    case "math": {
      // 数学节点类型来自 mdast-util-math 的模块增强，@types/mdast 未覆盖，此处显式收窄。
      const value = (node as unknown as { value: string }).value;
      return <span key={key} className="math math-display" dangerouslySetInnerHTML={{ __html: renderMath(value, true) }} />;
    }
    case "inlineMath": {
      const value = (node as unknown as { value: string }).value;
      return <span key={key} className="math math-inline" dangerouslySetInnerHTML={{ __html: renderMath(value, false) }} />;
    }
    case "footnoteReference": {
      const label = node.label ?? node.identifier;
      const id = `user-content-fnref-${node.identifier}`;
      return (
        <sup key={key} id={id}>
          <a href={`#user-content-fn-${node.identifier}`}>{label}</a>
        </sup>
      );
    }
    case "definition":
    case "footnoteDefinition":
      return null;
    default:
      return null;
  }
}

function renderMarkdown(content: string): ReactNode[] {
  const root = fromMarkdown(content, {
    extensions: [gfm(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  });
  const definitions: ReferenceTargets = new Map();
  const footnotes: FootnoteDefinitions = new Map();
  for (const node of root.children) {
    if (node.type === "definition" && !definitions.has(node.identifier.toUpperCase())) definitions.set(node.identifier.toUpperCase(), node);
    if (node.type === "footnoteDefinition" && !footnotes.has(node.identifier)) {
      footnotes.set(node.identifier, node as unknown as FootnoteDefinitionNode);
    }
  }
  const children = renderChildren(root.children, definitions);
  if (footnotes.size === 0) return children;
  return [
    ...children,
    <section key="footnotes" data-footnotes className="footnotes" aria-label="Footnotes">
      <h2 id="footnote-label" className="sr-only">Footnotes</h2>
      <ol>
        {[...footnotes.values()].map((definition) => (
          <li key={definition.identifier} id={`user-content-fn-${definition.identifier}`}>
            {renderChildren(definition.children, definitions)}
            <a href={`#user-content-fnref-${definition.identifier}`} aria-label={`Back to reference ${definition.label ?? definition.identifier}`}>↩</a>
          </li>
        ))}
      </ol>
    </section>,
  ];
}

/** DSH-style read-only Markdown renderer for untrusted Agent content. */
export function Markdown({ content, className, density = "comfortable", style }: {
  content: string;
  className?: string;
  density?: "comfortable" | "compact";
  style?: CSSProperties;
}) {
  const children = useMemo(() => renderMarkdown(content), [content]);
  const classes = [styles.markdown, density === "compact" ? styles.compact : "", className].filter(Boolean).join(" ");
  return <div className={classes} style={style}>{children}</div>;
}
