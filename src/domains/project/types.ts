export type Project = {
  id: string;
  name: string;
  /** 本机绑定目录。远端同步来的项目在绑定目录前为 null。 */
  directoryPath: string | null;
  /** 项目在工作区（S3 加密对象）中的稳定标识；本机新建尚未同步时为 null。 */
  workspaceProjectId: string | null;
  /** 远端归档标记（墓碑）。归档项目在列表中隐藏。 */
  workspaceArchived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTaskStatus = "draft" | "submitted" | "in_progress" | "review" | "done";

/** 前端可手动写入的任务状态（审核推进 / 退回重排），不含草稿。 */
export type ProjectTaskMutableStatus = "submitted" | "in_progress" | "review" | "done";

export type ProjectTaskType = "code" | "readonly";

export type ProjectTaskPriority = "p0" | "p1" | "p2";

export type ProjectTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: ProjectTaskStatus;
  taskType: ProjectTaskType;
  agentProfile: string;
  priority: ProjectTaskPriority;
  /** 基于某个已完成任务创建时记录其任务 id；执行时复用该任务的 Agent 会话继续推进。 */
  baseTaskId: string | null;
  /** 最近一次执行的 background_job id（只读详情展示 Agent 执行情况用）。 */
  lastJobId: string | null;
  /** 最近一次被退回的原因。执行时注入给 Agent 后清空（不重复注入）。 */
  rejectionReason: string | null;
  /** 执行历史（JSON 数组字符串），每次执行追加一条，供只读详情展示全部历史与退回原因。 */
  executionHistory: string | null;
  createdAt: string;
  updatedAt: string;
};

/** executionHistory JSON 数组的单条记录。 */
export type TaskExecutionRecord = {
  jobId: string;
  startedAt: string;
  /** 本轮进入待处理（提交 / 退回）的时刻，用于计算等待耗时；旧数据可能缺失为 null。 */
  submittedAt: string | null;
  /** 本轮执行的结束时间（执行结束时由 Rust 写入真实结束时刻）；null 表示尚未结束或旧数据缺失。 */
  finishedAt: string | null;
  /** 本轮等待耗时（毫秒，进入待处理 → 开始执行）；旧数据可能缺失为 null。 */
  waitingMs: number | null;
  /** 本轮执行耗时（毫秒，开始执行 → 真实结束）；旧数据可能缺失为 null。 */
  executionMs: number | null;
  rejected: boolean;
  rejectionReason: string | null;
  rejectedAt: string | null;
};

/** 解析任务 executionHistory JSON 字符串。 */
export function parseTaskExecutionHistory(history: string | null): TaskExecutionRecord[] {
  if (!history) return [];
  try {
    const parsed: unknown = JSON.parse(history);
    return Array.isArray(parsed) ? parsed as TaskExecutionRecord[] : [];
  } catch {
    return [];
  }
}

/**
 * 构造任务展示用的执行历史：
 * 优先解析 `executionHistory`；若为空但存在最近一次执行的 job（`lastJobId`），
 * 回退为该次执行，避免早期任务未记录历史时「Agent 执行情况」整段空白。
 */
export function taskExecutionHistory(
  task: Pick<ProjectTask, "executionHistory" | "lastJobId">,
): TaskExecutionRecord[] {
  const parsed = parseTaskExecutionHistory(task.executionHistory);
  if (parsed.length > 0) return parsed;
  if (task.lastJobId) {
    return [
      {
        jobId: task.lastJobId,
        startedAt: "",
        submittedAt: null,
        finishedAt: null,
        waitingMs: null,
        executionMs: null,
        rejected: false,
        rejectionReason: null,
        rejectedAt: null,
      },
    ];
  }
  return [];
}

/**
 * 计算任务累计执行时间（毫秒）。用于看板卡片左下角「执行时间」与概览抽屉。
 * 每轮执行时长取真实执行结束时刻，多轮被退回后重新执行时累计每一轮，**不**把
 * 退回 / 审核等待时间计入。每轮时长来源优先级：
 * 1. `executionMs`（执行结束时由 Rust 按真实结束时刻写入）；
 * 2. `runningJobId` 命中（当前正在执行的轮次）时取 `now - startedAt`（实时增长）；
 * 3. `finishedAt - startedAt`（旧数据回退，仍为真实执行结束时刻）。
 * 以上都不可得的轮次贡献 0。
 */
export function taskTotalExecutionDuration(
  task: Pick<ProjectTask, "executionHistory" | "lastJobId">,
  runningJobId: string | null,
  now: number,
): number {
  let total = 0;
  for (const record of taskExecutionHistory(task)) {
    if (runningJobId != null && record.jobId === runningJobId) {
      const start = parseTaskTimestamp(record.startedAt);
      if (start != null) total += Math.max(0, now - start);
      continue;
    }
    if (typeof record.executionMs === "number") {
      total += Math.max(0, record.executionMs);
      continue;
    }
    const start = parseTaskTimestamp(record.startedAt);
    const endedAt = parseTaskTimestamp(record.finishedAt);
    if (start == null || endedAt == null) continue;
    total += Math.max(0, endedAt - start);
  }
  return total;
}

/**
 * 计算任务累计等待时间（毫秒）。每轮等待时长 = 开始执行 - 进入待处理时刻，
 * 由 Rust 在执行开始时写入 `waitingMs`；多轮（含被退回后重新提交）累计每一轮。
 * 旧数据缺失该字段的轮次贡献 0。
 */
export function taskTotalWaitingDuration(
  task: Pick<ProjectTask, "executionHistory" | "lastJobId">,
): number {
  let total = 0;
  for (const record of taskExecutionHistory(task)) {
    if (typeof record.waitingMs === "number") {
      total += Math.max(0, record.waitingMs);
    }
  }
  return total;
}

/**
 * 已提交待执行任务的等待时长（毫秒）：从最近一次提交 / 退回时刻（`updatedAt`）起算。
 * 被退回重新排队时不累计历史等待时间，从退回时刻重新计时。
 * 时间解析失败返回 null。
 */
export function taskWaitingDuration(
  task: Pick<ProjectTask, "updatedAt">,
  now: number,
): number | null {
  const start = parseTaskTimestamp(task.updatedAt);
  if (start == null) return null;
  return Math.max(0, now - start);
}

/** 解析后端时间戳：ISO 8601 原样，SQLite "YYYY-MM-DD HH:MM:SS" 视为 UTC 归一化。解析失败返回 null。 */
function parseTaskTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const millis = new Date(iso).getTime();
  return Number.isNaN(millis) ? null : millis;
}

/** 全局唯一执行槽状态：当前是否有任务在执行、是哪个任务。 */
export type ProjectTaskRunnerState = {
  running: boolean;
  current: {
    projectId: string;
    taskId: string;
    taskTitle: string;
    agentProfile: string;
    jobId: string;
    startedAt: string;
  } | null;
};

/** run_project_task 领取结果。 */
export type RunProjectTaskResult = {
  started: boolean;
  jobId: string | null;
  message: string;
};

/** 项目工作区同步状态（设置页展示）。 */
export type ProjectWorkspaceStatus = {
  enabled: boolean;
  syncedProjects: number;
  localOnlyProjects: number;
};

/** sync_project_workspace 结果。 */
export type ProjectWorkspaceSyncResult = {
  syncedProjects: number;
  createdLocalProjects: number;
  archivedProjects: number;
  taskCount: number;
  uploadedObjects: number;
};
