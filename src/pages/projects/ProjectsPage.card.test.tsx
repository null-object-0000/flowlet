import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ProjectTask } from "../../domains/project/types";
import { TaskCard, type CardAction } from "./ProjectsPage";
import styles from "./ProjectsPage.module.css";

vi.mock("../../app/preferences/AppPreferences", () => ({
  useAppPreferences: () => ({
    t: (key: string, variables?: Record<string, string | number>) => {
      if (!variables) return key;
      return key.replace(/\{(\w+)\}/g, (_, name: string) => String(variables[name]));
    },
  }),
}));

function makeTask(overrides: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "11111111-2222-3333-4444-555555555555",
    projectId: "project-1",
    title: "新建 Flowlet 任务支持自动生成任务标题",
    description: "",
    status: "done",
    taskType: "code",
    agentProfile: "Claude Code",
    priority: "p2",
    baseTaskId: null,
    lastJobId: null,
    rejectionReason: null,
    executionHistory: null,
    claimedBy: null,
    queueBoostedAt: null,
    createdAt: "2026-08-06T00:00:00.000Z",
    updatedAt: "2026-08-06T00:00:00.000Z",
    ...overrides,
  };
}

function renderCard(task: ProjectTask, props: Partial<Parameters<typeof TaskCard>[0]> = {}) {
  const taskById = props.taskById ?? new Map([[task.id, task]]);
  return render(
    <TaskCard
      task={task}
      taskById={taskById}
      onOpen={vi.fn()}
      actions={[]}
      meta={<span>执行 23.1 min</span>}
      {...props}
    />,
  );
}

describe("TaskCard 已完成卡片：下方两行布局", () => {
  it("标题在上，基础信息行「代码修改 · Claude Code」+ 时间，不展示执行轮次", () => {
    const task = makeTask({ status: "done" });
    const { container } = renderCard(task);

    expect(screen.getByText(task.title)).toBeTruthy();
    expect(screen.getByText("代码修改 · Claude Code")).toBeTruthy();
    expect(screen.getByText("执行 23.1 min")).toBeTruthy();
    expect(screen.queryByText("第 1 轮")).toBeNull();

    // 标题位于第一行（head），基础信息行包含「类型 · Agent」与时间（两端对齐）。
    const head = container.querySelector(`.${styles.taskCardHead}`)!;
    expect(head.textContent).toContain(task.title);
    const metaRow = container.querySelector(`.${styles.taskCardMetaRow}`)!;
    expect(metaRow).toBeTruthy();
    expect(metaRow.textContent).toContain("代码修改 · Claude Code");
    expect(metaRow.textContent).toContain("执行 23.1 min");
  });
});

describe("TaskCard 其他状态：保持原有行结构，仅合并元信息", () => {
  it("第一行合并元信息（第 1 轮 代码修改 · Claude Code），第二行标题，时间独立一行", () => {
    const task = makeTask({ status: "submitted" });
    const { container } = renderCard(task);

    expect(screen.getByText(task.title)).toBeTruthy();
    expect(screen.getByText("第 1 轮")).toBeTruthy();
    expect(screen.getByText("代码修改 · Claude Code")).toBeTruthy();
    expect(screen.getByText("执行 23.1 min")).toBeTruthy();

    // 元信息行在标题上方：执行轮次位于第一行 head 内，标题位于其后的独立行（taskTitleStandalone）。
    const head = container.querySelector(`.${styles.taskCardHead}`)!;
    expect(head.textContent).toContain("第 1 轮");
    expect(head.textContent).toContain("代码修改 · Claude Code");
    const titleStandalone = container.querySelector(`.${styles.taskTitleStandalone}`)!;
    expect(titleStandalone).toBeTruthy();
    expect(titleStandalone.textContent).toContain(task.title);
    expect(head.compareDocumentPosition(titleStandalone) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    // 非已完成不使用已完成的两端对齐基础信息行。
    expect(container.querySelector(`.${styles.taskCardMetaRow}`)).toBeNull();
  });

  it("待处理 / 进行中 / 待审核均展示第 1 轮标签（从未执行的任务）", () => {
    for (const status of ["draft", "submitted", "in_progress", "review"] as const) {
      const { unmount } = renderCard(makeTask({ status }));
      expect(screen.getByText("第 1 轮")).toBeTruthy();
      expect(screen.getByText("代码修改 · Claude Code")).toBeTruthy();
      unmount();
    }
  });

  it("执行过一轮并退回重排的任务展示第 2 轮标签", () => {
    const executionHistory = JSON.stringify([{
      jobId: "job-1",
      startedAt: "2026-08-06T00:00:00.000Z",
      submittedAt: null,
      finishedAt: null,
      waitingMs: 0,
      executionMs: null,
      rejected: true,
      rejectionReason: "不符合预期",
      rejectedAt: "2026-08-06T01:00:00.000Z",
    }]);
    renderCard(makeTask({ status: "submitted", executionHistory }));
    expect(screen.getByText("第 2 轮")).toBeTruthy();
  });

  it("执行过一轮后撤回的修订草稿展示第 2 轮草稿标签", () => {
    const executionHistory = JSON.stringify([{
      jobId: "job-1",
      startedAt: "2026-08-06T00:00:00.000Z",
      submittedAt: null,
      finishedAt: "2026-08-06T01:00:00.000Z",
      waitingMs: 0,
      executionMs: 3_600_000,
      rejected: true,
      rejectionReason: "补充第二轮要求",
      rejectedAt: "2026-08-06T02:00:00.000Z",
    }]);
    renderCard(makeTask({ status: "draft", executionHistory }));
    expect(screen.getByText("第 2 轮草稿")).toBeTruthy();
  });

  it("只读分析类型展示「只读分析 · Agent」", () => {
    const task = makeTask({ status: "submitted", taskType: "readonly", agentProfile: "OpenCode" });
    renderCard(task);
    expect(screen.getByText("只读分析 · OpenCode")).toBeTruthy();
  });

  it("待审核卡片使用左侧橙色强调线样式（taskCardReview），非待审核不应用", () => {
    const review = makeTask({ status: "review" });
    const { container } = renderCard(review);
    const article = container.querySelector("article")!;
    expect(article.className).toContain("taskCardReview");
    expect(article.className).toContain(styles.taskCardReview);

    const plain = makeTask({ status: "in_progress" });
    const { container: plainContainer } = renderCard(plain);
    expect(plainContainer.querySelector("article")!.className).not.toContain("taskCardReview");
  });
});

describe("TaskCard 父任务 / 子任务", () => {
  const parent = makeTask({ title: "父任务", id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" });
  const child = makeTask({ title: "子任务", id: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff", baseTaskId: parent.id });
  const taskById = new Map([[parent.id, parent], [child.id, child]]);

  it("独立展示（depth 0）且带 baseTaskId 时渲染「基于」父任务行", () => {
    renderCard(child, { taskById });
    expect(screen.getByText(/基于/)).toBeTruthy();
  });

  it("已完成树内的子任务（depth > 0）不再重复渲染「基于」行", () => {
    renderCard(child, { taskById, depth: 1 });
    expect(screen.queryByText(/基于/)).toBeNull();
  });
});

describe("TaskCard 交互动作：单个直接按钮 / 多个三点菜单", () => {
  const action = (key: string, label: string, onClick = vi.fn()): CardAction => ({ key, label, onClick });

  it("单个动作在卡片右下角直接渲染按钮（taskCardAction），不渲染三点菜单", () => {
    const onClick = vi.fn();
    const { container } = renderCard(makeTask({ status: "submitted" }), { actions: [action("withdraw", "撤回", onClick)] });

    const direct = container.querySelector(`.${styles.taskCardAction}`)!;
    expect(direct).toBeTruthy();
    expect(direct.textContent).toContain("撤回");
    // 单个动作不出现右上角 ⋯ 菜单按钮。
    expect(container.querySelector(`.${styles.taskCardMenu}`)).toBeNull();
  });

  it("动作带 icon 时，按钮内渲染图标元素", () => {
    const { container } = renderCard(makeTask({ status: "submitted" }), {
      actions: [{ key: "withdraw", label: "撤回", icon: <span data-testid="withdraw-icon">↩</span>, onClick: vi.fn() }],
    });
    const direct = container.querySelector(`.${styles.taskCardAction}`)!;
    expect(direct.querySelector('[data-testid="withdraw-icon"]')).toBeTruthy();
  });

  it("点击右下角单按钮触发动作 onClick 且不触发 onOpen", () => {
    const onClick = vi.fn();
    const onOpen = vi.fn();
    const { container } = render(
      <TaskCard
        task={makeTask({ status: "submitted" })}
        taskById={new Map()}
        onOpen={onOpen}
        actions={[action("withdraw", "撤回", onClick)]}
        meta={<span>执行 1 min</span>}
      />,
    );
    const direct = container.querySelector(`.${styles.taskCardAction}`)! as HTMLButtonElement;
    fireEvent.click(direct);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("多个动作收进右上角 ⋯ 菜单（taskCardMenu），不渲染右下角单按钮", () => {
    const { container } = renderCard(makeTask({ status: "review" }), {
      actions: [action("reject", "退回"), action("approve", "批准")],
    });

    expect(container.querySelector(`.${styles.taskCardMenu}`)).toBeTruthy();
    expect(container.querySelector(`.${styles.taskCardAction}`)).toBeNull();
  });

  it("非菜单状态（submitted）的多个动作直接并排渲染，不进三点菜单", () => {
    const { container } = renderCard(makeTask({ status: "submitted" }), {
      actions: [action("boost", "置顶"), action("withdraw", "撤回")],
    });

    // 两个动作都作为右下角直接按钮渲染，且包裹在 actionRow 容器中。
    const row = container.querySelector(`.${styles.taskCardActionRow}`)!;
    expect(row).toBeTruthy();
    const buttons = row.querySelectorAll(`.${styles.taskCardAction}`);
    expect(buttons.length).toBe(2);
    expect(buttons[0].textContent).toContain("置顶");
    expect(buttons[1].textContent).toContain("撤回");
    // 不渲染三点菜单。
    expect(container.querySelector(`.${styles.taskCardMenu}`)).toBeNull();
  });

  it("进行中任务的单个动作收进右上角 ⋯ 菜单，右下角不再渲染按钮", () => {
    const { container } = renderCard(makeTask({ status: "in_progress" }), {
      actions: [action("handle", "处理")],
    });

    expect(container.querySelector(`.${styles.taskCardMenu}`)).toBeTruthy();
    expect(container.querySelector(`.${styles.taskCardAction}`)).toBeNull();
  });

  it("待审核任务的单个动作同样收进右上角 ⋯ 菜单", () => {
    const { container } = renderCard(makeTask({ status: "review" }), {
      actions: [action("approve", "批准")],
    });

    expect(container.querySelector(`.${styles.taskCardMenu}`)).toBeTruthy();
    expect(container.querySelector(`.${styles.taskCardAction}`)).toBeNull();
  });

  it("无动作时既无右下角按钮也无三点菜单", () => {
    const { container } = renderCard(makeTask({ status: "done" }), { actions: [] });
    expect(container.querySelector(`.${styles.taskCardAction}`)).toBeNull();
    expect(container.querySelector(`.${styles.taskCardMenu}`)).toBeNull();
  });

  it("进行中卡片 trailing（token 消耗）渲染在执行耗时行右侧", () => {
    const { container } = renderCard(makeTask({ status: "in_progress" }), {
      actions: [action("handle", "处理")],
      trailing: <span>1.8k tokens ≈¥0.03</span>,
    });

    expect(screen.getByText("1.8k tokens ≈¥0.03")).toBeTruthy();
    const metaRow = container.querySelector(`.${styles.taskCardMetaActions}`)!;
    expect(metaRow.textContent).toContain("1.8k tokens ≈¥0.03");
  });

  it("进行中卡片 trailing 与 meta 同一行两端对齐（space-between）", () => {
    const { container } = renderCard(makeTask({ status: "in_progress" }), {
      trailing: <span>消耗统计中</span>,
    });

    const metaRight = container.querySelector(`.${styles.taskCardMetaRight}`)!;
    expect(metaRight.textContent).toContain("执行 23.1 min");
    const metaRow = container.querySelector(`.${styles.taskCardMetaActions}`)!;
    expect(metaRow.textContent).toContain("消耗统计中");
  });
});

describe("TaskCard 展开 / 收缩", () => {
  it("可展开父任务在收缩时展示子任务数量徽标，展开时不展示", () => {
    const task = makeTask({ title: "父任务" });
    const { rerender } = renderCard(task, { expandable: true, expanded: false, childCount: 2 });

    const button = screen.getByLabelText("展开子任务");
    expect(button).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();

    rerender(
      <TaskCard
        task={task}
        taskById={new Map([[task.id, task]])}
        onOpen={vi.fn()}
        actions={[]}
        meta={<span>执行 1 min</span>}
        expandable
        expanded
        childCount={2}
      >
        <div>子任务列表</div>
      </TaskCard>,
    );
    expect(screen.getByLabelText("收缩子任务")).toBeTruthy();
    expect(screen.queryByText("2")).toBeNull();
    expect(screen.getByText("子任务列表")).toBeTruthy();
  });

  it("点击展开/收缩按钮触发 onToggleExpand，且不触发 onOpen", () => {
    const task = makeTask({ title: "父任务" });
    const onOpen = vi.fn();
    const onToggleExpand = vi.fn();
    render(
      <TaskCard
        task={task}
        taskById={new Map([[task.id, task]])}
        onOpen={onOpen}
        actions={[]}
        meta={<span>执行 1 min</span>}
        expandable
        expanded={false}
        childCount={1}
        onToggleExpand={onToggleExpand}
      />,
    );
    fireEvent.click(screen.getByLabelText("展开子任务"));
    expect(onToggleExpand).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
