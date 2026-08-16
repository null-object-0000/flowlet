import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders markdown structures as native semantic elements", () => {
    render(<Markdown content={"## 标题\n\n正文 **加粗** 和 `code`\n\n- 第一项\n- 第二项"} />);

    expect(screen.getByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByText("加粗").tagName).toBe("STRONG");
    expect(screen.getByText("code").tagName).toBe("CODE");
    expect(screen.getByText("第一项").closest("li")).not.toBeNull();
    expect(screen.getByText("第二项").closest("li")).not.toBeNull();
  });

  it("applies the shared compact typography variant", () => {
    const { container } = render(<Markdown content="## Compact" density="compact" />);

    expect(screen.getByRole("heading", { name: "Compact" })).toBeInTheDocument();
    expect(container.firstElementChild?.className).toContain("compact");
  });

  it("renders GFM tables without Semi pagination or table wrappers", () => {
    const { container } = render(<Markdown content={"| # | 功能 | 说明 |\n| - | - | - |\n| A1 | 渠道账号管理 | 路由对账 |\n| A2 | 开放模型 | 模型目录 |"} />);

    expect(screen.getByRole("table")).toBeInTheDocument();
    expect(screen.getByRole("columnheader", { name: "功能" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "开放模型" })).toBeInTheDocument();
    expect(container.querySelector(".semi-table-wrapper")).toBeNull();
    expect(container.querySelector(".semi-page")).toBeNull();
  });

  it("opens links in a new tab without referrer", () => {
    render(<Markdown content="[Flowlet](https://flowlet.example/path)" />);

    const link = screen.getByRole("link", { name: "Flowlet" });
    expect(link).toHaveAttribute("href", "https://flowlet.example/path");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("keeps raw html literal instead of injecting it", () => {
    render(<Markdown content={'纯文本 <img src="x" onerror="window.__xss = true" /> 后续'} />);

    expect(screen.getByText(/纯文本/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("does not create links for unsafe protocols", () => {
    render(<Markdown content="[执行](javascript:alert(1))" />);

    expect(screen.getByText("执行")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "执行" })).toBeNull();
  });

  it("uses the DSH code-block chrome", () => {
    render(<Markdown content={"```ts\nconst answer = 42;\n```"} />);

    expect(screen.getByText("ts")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "复制" })).toBeInTheDocument();
    expect(screen.getByText("const answer = 42;").tagName).toBe("CODE");
  });

  it("highlights fenced code with shiki once the grammar is loaded", async () => {
    const { container } = render(<Markdown content={"```ts\nconst n: number = 1;\n```"} />);
    // 异步加载：先纯文本回退，随后出现 shiki 高亮层。
    await waitFor(() => expect(container.querySelector("pre.shiki")).toBeTruthy(), { timeout: 10_000 });
    expect(container.querySelector(".shiki code")?.textContent).toContain("const n: number = 1;");
  });

  it("renders KaTeX math with the official three-arm fallback", () => {
    const { container } = render(<Markdown content={"行内 $E = mc^2$\n\n$$\n\\frac{a}{b}\n$$"} />);
    expect(container.querySelectorAll(".katex").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".math-inline")).not.toBeNull();
    expect(container.querySelector(".math-display")).not.toBeNull();
  });

  it("renders footnotes with ↩ back-references", () => {
    const { container } = render(<Markdown content={"正文[^1]\n\n[^1]: 脚注内容。"} />);
    const reference = container.querySelector('a[href="#user-content-fn-1"]');
    expect(reference).not.toBeNull();
    const footnote = container.querySelector('#user-content-fn-1');
    expect(footnote).not.toBeNull();
    expect(footnote?.textContent).toContain("脚注内容");
    expect(container.querySelector('a[href="#user-content-fnref-1"]')?.textContent).toBe("↩");
  });
});
