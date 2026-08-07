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

/** 前端可手动写入的任务状态（审核推进 / 退回重排 / 撤回），不含执行器管理的 in_progress。 */
export type ProjectTaskMutableStatus = "draft" | "submitted" | "review" | "done";

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
  /** 最近一次执行该任务的设备 id（跨设备执行归属）。任务被某设备执行后永久归属该设备，
   *  其他设备只能查看。工作区同步来的已执行任务在本机为 null（归属在源设备）。 */
  claimedBy: string | null;
  /** 队列置顶时间（RFC3339）：已提交待执行任务被用户「置顶」提到队列最前。
   *  设备本地字段，不参与工作区同步；任务被领取执行时清空。 */
  queueBoostedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * 任务是否已执行过：`executionHistory` 存在且解析出的执行记录非空
 * （`[]` / 空串视为未执行）。用于跨设备权限判断——执行过的任务只允许执行设备操作。
 */
export function taskHasExecution(task: Pick<ProjectTask, "executionHistory">): boolean {
  return parseTaskExecutionHistory(task.executionHistory).length > 0;
}

/** 已执行过、又从重新排队状态撤回的草稿：正在准备下一轮，而不是首次草稿。 */
export function taskIsRevisionDraft(
  task: Pick<ProjectTask, "executionHistory" | "status">,
): boolean {
  return task.status === "draft" && taskHasExecution(task);
}

/**
 * 由执行轮次计数 + 状态推导「任务当前处于第几轮执行」。
 * `executionHistory` 每条记录代表一轮已开始（或已完成）的执行：
 * - `draft` / `submitted` 正在准备或排队下一轮 → 历史轮数 + 1；
 * - 进行中 / 待审核 / 已完成 → 当前轮次即历史轮数（从未执行过的任务记为第 1 轮）。
 * 与 PC 看板 `taskExecutionRound` 共用，移动端快照只带计数时复用。
 */
export function executionRoundFromCount(count: number, status: ProjectTaskStatus): number {
  if (status === "draft" || status === "submitted") return count + 1;
  return Math.max(1, count);
}

/** 计算任务当前所处执行轮次（详见 `executionRoundFromCount`）。 */
export function taskExecutionRound(
  task: Pick<ProjectTask, "executionHistory" | "status">,
): number {
  return executionRoundFromCount(parseTaskExecutionHistory(task.executionHistory).length, task.status);
}

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
  /** 本轮执行是否被应用重启中断（由 Rust 启动恢复时写入）。中断后任务回到待处理重新排队。 */
  interrupted?: boolean;
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
 * 计算任务最近一次（本轮）执行耗时（毫秒）。用于看板卡片进行中 / 待审核状态
 * 展示「本轮耗时」：该状态下卡片只关心当前这轮跑了多久，不累计历史轮次。
 * 取最后一条执行历史记录：
 * 1. `runningJobId` 命中（当前正在执行的轮次）时取 `now - startedAt`（实时增长）；
 * 2. `executionMs`（执行结束时按真实结束时刻写入）；
 * 3. `finishedAt - startedAt`（旧数据回退）。
 * 无法解析开始时间时返回 0。
 */
export function taskLatestExecutionDuration(
  task: Pick<ProjectTask, "executionHistory" | "lastJobId">,
  runningJobId: string | null,
  now: number,
): number {
  const records = taskExecutionHistory(task);
  const latest = records[records.length - 1];
  if (!latest) return 0;
  if (runningJobId != null && latest.jobId === runningJobId) {
    const start = parseTaskTimestamp(latest.startedAt);
    if (start == null) return 0;
    return Math.max(0, now - start);
  }
  if (typeof latest.executionMs === "number") {
    return Math.max(0, latest.executionMs);
  }
  const start = parseTaskTimestamp(latest.startedAt);
  const endedAt = parseTaskTimestamp(latest.finishedAt);
  if (start == null || endedAt == null) return 0;
  return Math.max(0, endedAt - start);
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

/**
 * 单轮执行记录的等待耗时（毫秒）。优先 `waitingMs`（执行开始时由 Rust 写入
 * 进入待处理 → 开始执行）；旧数据缺失时回退 `submittedAt → startedAt`；
 * 无法解析返回 null。
 */
export function taskRecordWaitingDuration(record: TaskExecutionRecord): number | null {
  if (typeof record.waitingMs === "number") return Math.max(0, record.waitingMs);
  const submitted = parseTaskTimestamp(record.submittedAt);
  const started = parseTaskTimestamp(record.startedAt);
  if (submitted == null || started == null) return null;
  return Math.max(0, started - submitted);
}

/**
 * 单轮执行记录的执行耗时（毫秒）。`runningJobId` 命中当前轮次时取
 * `now - startedAt`（实时增长，进行中轮次）；否则优先 `executionMs`
 * （执行结束时按真实结束时刻写入）；旧数据缺失时回退 `startedAt → finishedAt`；
 * 无法解析返回 null。
 */
export function taskRecordExecutionDuration(
  record: TaskExecutionRecord,
  runningJobId: string | null,
  now: number,
): number | null {
  if (runningJobId != null && record.jobId === runningJobId) {
    const started = parseTaskTimestamp(record.startedAt);
    return started == null ? null : Math.max(0, now - started);
  }
  if (typeof record.executionMs === "number") return Math.max(0, record.executionMs);
  const started = parseTaskTimestamp(record.startedAt);
  const finished = parseTaskTimestamp(record.finishedAt);
  if (started == null || finished == null) return null;
  return Math.max(0, finished - started);
}

/** 解析后端时间戳：ISO 8601 原样，SQLite "YYYY-MM-DD HH:MM:SS" 视为 UTC 归一化。解析失败返回 null。 */
function parseTaskTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const iso = value.includes("T") || value.endsWith("Z") ? value : `${value.replace(" ", "T")}Z`;
  const millis = new Date(iso).getTime();
  return Number.isNaN(millis) ? null : millis;
}

/** 按项目隔离的执行槽状态：当前有哪些任务在执行（每个项目至多一个）。 */
export type ProjectTaskRunnerState = {
  /** 是否有任意项目的任务在执行（调度器按项目粒度判断，不依赖该字段阻塞全局）。 */
  running: boolean;
  /** 当前正在执行的任务列表（不同项目可并行，每个项目至多一个）。 */
  current: Array<{
    projectId: string;
    taskId: string;
    taskTitle: string;
    agentProfile: string;
    jobId: string;
    startedAt: string;
  }>;
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
