export type Project = {
  id: string;
  name: string;
  directoryPath: string;
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
