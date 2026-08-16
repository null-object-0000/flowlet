import { useCallback, useEffect, useRef, useState } from "react";

import { ensureLanguage, highlightToHtml } from "./syntaxHighlight";
import styles from "./MarkdownCodeBlock.module.css";

export function MarkdownCodeBlock({ code, language }: { code: string; language?: string }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);
  const [html, setHtml] = useState<string | null | undefined>(undefined);
  const copy = useCallback(() => {
    if (copied || !navigator.clipboard) return;
    const text = rootRef.current?.querySelector("pre")?.textContent ?? code;
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1_000);
    }).catch(() => undefined);
  }, [code, copied]);

  // 异步加载语法 + 高亮；加载完成前渲染纯文本回退（避免阻塞主线程）。
  useEffect(() => {
    let cancelled = false;
    void ensureLanguage(language).then(() => {
      if (cancelled) return;
      void highlightToHtml(code, language).then((result) => {
        if (!cancelled) setHtml(result);
      });
    });
    return () => {
      cancelled = true;
    };
  }, [code, language]);

  const body = html
    ? <div className={styles.highlight} dangerouslySetInnerHTML={{ __html: html }} />
    : <pre><code className={language ? `language-${language}` : undefined}>{code}</code></pre>;

  return (
    <div ref={rootRef} className={styles.block}>
      <div className={styles.bannerWrap}>
        <div className={styles.banner}>
          <span className={styles.language}>{language ?? ""}</span>
          <button type="button" className={styles.copyButton} onClick={copy}>{copied ? "复制成功" : "复制"}</button>
        </div>
      </div>
      {body}
    </div>
  );
}