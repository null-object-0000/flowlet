import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ProjectsBoardDemoView } from "./ProjectsBoardDemoView";

describe("ProjectsBoardDemoView", () => {
  it("shows realistic queued, running and review task states", () => {
    render(<ProjectsBoardDemoView zh />);

    const queued = screen.getByText("待处理").closest("section") as HTMLElement;
    const running = screen.getByText("进行中").closest("section") as HTMLElement;
    const review = screen.getByText("待审核").closest("section") as HTMLElement;

    expect(within(queued).getByText("补齐官网产品演示的共享组件")).toBeTruthy();
    expect(within(queued).getAllByRole("button", { name: /添加任务/ })).toHaveLength(2);
    expect(within(running).getByText("统一任务看板与官网 Demo")).toBeTruthy();
    expect(within(running).getByText("4.28M tokens ≈¥0.22")).toBeTruthy();
    expect(within(review).getByText("修复请求日志底部分页布局")).toBeTruthy();
    expect(within(review).getByText("7.90M tokens ≈¥0.39")).toBeTruthy();
  });
});
