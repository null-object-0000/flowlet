import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TaskLogsDemoView } from "./TaskLogsDemoView";

describe("TaskLogsDemoView", () => {
  it("renders task data and opens a selected task detail", () => {
    render(<TaskLogsDemoView zh />);
    expect(screen.getAllByText("渠道资源自动同步").length).toBeGreaterThan(1);
    fireEvent.click(screen.getByRole("button", { name: /官网产品能力核对/ }));
    expect(screen.getAllByText("官网产品能力核对").length).toBeGreaterThan(1);
    expect(screen.getByText("8m 16s", { selector: "strong" })).toBeTruthy();
  });
});
