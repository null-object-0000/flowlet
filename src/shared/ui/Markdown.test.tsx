import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders markdown structures asynchronously", async () => {
    render(<Markdown content={"## 标题\n\n正文 **加粗** 和 `code`\n\n- 第一项\n- 第二项"} />);

    expect(await screen.findByRole("heading", { name: "标题" })).toBeInTheDocument();
    expect(screen.getByText("加粗").tagName).toBe("STRONG");
    // Semi MarkdownRender 将无语言的行内 code 渲染为 simple-code 样式的 span。
    expect(screen.getByText("code").closest("span")).toHaveClass("semi-markdownRender-simple-code");
    expect(screen.getByText("第一项").closest("li")).not.toBeNull();
    expect(screen.getByText("第二项").closest("li")).not.toBeNull();
  });

  it("opens links in a new tab without referrer", async () => {
    render(<Markdown content="[Flowlet](https://flowlet.example/path)" />);

    const link = await screen.findByRole("link", { name: "Flowlet" });
    expect(link).toHaveAttribute("href", "https://flowlet.example/path");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer");
  });

  it("strips raw html instead of injecting it", async () => {
    render(<Markdown content={'纯文本 <img src="x" onerror="window.__xss = true" /> 后续'} />);

    expect(await screen.findByText(/纯文本/)).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });
});
