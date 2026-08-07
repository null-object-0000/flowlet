import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectCommands } from "../../domains/project/commands";
import type { Project, ProjectTask, ProjectTaskMutableStatus, ProjectTaskRunnerState } from "../../domains/project/types";
import { queryKeys } from "../../shared/query-keys";

export function useProjects() {
  return useQuery({ queryKey: queryKeys.project.list(), queryFn: projectCommands.list });
}

export function useProject(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project.detail(projectId ?? ""),
    queryFn: () => projectCommands.get(projectId!),
    enabled: Boolean(projectId),
  });
}

export function useProjectTasks(projectId: string | undefined, autoRefresh = false, intervalMs = 15_000) {
  return useQuery({
    queryKey: queryKeys.project.tasks(projectId ?? ""),
    queryFn: () => projectCommands.listTasks(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: autoRefresh ? intervalMs : false,
    refetchOnWindowFocus: false,
  });
}

export function useProjectActions() {
  const queryClient = useQueryClient();
  const saveProject = useMutation({
    mutationFn: projectCommands.save,
    onSuccess: async (_, project) => Promise.all([
      queryClient.invalidateQueries({ queryKey: queryKeys.project.list() }),
      queryClient.invalidateQueries({ queryKey: queryKeys.project.detail(project.id) }),
    ]),
  });
  const deleteProject = useMutation({
    mutationFn: projectCommands.delete,
    onSuccess: async () => queryClient.invalidateQueries({ queryKey: queryKeys.project.all }),
  });
  return { saveProject, deleteProject };
}

export function useProjectTaskActions(projectId: string) {
  const queryClient = useQueryClient();
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.project.tasks(projectId) });
  const saveTask = useMutation({ mutationFn: (task: ProjectTask) => projectCommands.saveTask(task), onSuccess: refresh });
  const deleteTask = useMutation({ mutationFn: (taskId: string) => projectCommands.deleteTask(projectId, taskId), onSuccess: refresh });
  return { saveTask, deleteTask };
}

/** 按项目隔离的执行槽状态（当前哪些项目的任务在跑、各自是哪个任务）。 */
export function useProjectTaskRunnerState(autoRefresh = false, intervalMs = 5_000): ReturnType<typeof useQuery<ProjectTaskRunnerState>> {
  return useQuery({
    queryKey: queryKeys.projectTaskRunner.state(),
    queryFn: () => projectCommands.getTaskRunnerState(),
    refetchInterval: autoRefresh ? intervalMs : false,
    refetchOnWindowFocus: false,
  });
}

/** 跨项目聚合的「已提交、待执行」任务（按优先级 + 创建时间排序）。 */
export function useQueuedProjectTasks(autoRefresh = false, intervalMs = 10_000): ReturnType<typeof useQuery<ProjectTask[]>> {
  return useQuery({
    queryKey: queryKeys.projectTaskRunner.queued(),
    queryFn: () => projectCommands.listQueuedTasks(),
    refetchInterval: autoRefresh ? intervalMs : false,
    refetchOnWindowFocus: false,
  });
}

/** 调度与审核动作：领取执行、推进状态。成功后刷新所有项目相关 query。 */
export function useProjectTaskRunnerActions() {
  const queryClient = useQueryClient();
  const refreshAll = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.project.all });
    queryClient.invalidateQueries({ queryKey: queryKeys.projectTaskRunner.all });
  };
  const startTask = useMutation({
    mutationFn: ({ projectId, taskId }: { projectId: string; taskId: string }) =>
      projectCommands.runTask(projectId, taskId),
    onSuccess: refreshAll,
  });
  const setTaskStatus = useMutation({
    mutationFn: ({ taskId, status, reason }: { taskId: string; status: ProjectTaskMutableStatus; reason?: string }) =>
      projectCommands.setTaskStatus(taskId, status, reason),
    onSuccess: refreshAll,
  });
  const convertTaskToCode = useMutation({
    mutationFn: ({ taskId, description }: { taskId: string; description: string }) =>
      projectCommands.convertTaskToCode(taskId, description),
    onSuccess: refreshAll,
  });
  const boostTask = useMutation({
    mutationFn: (taskId: string) => projectCommands.boostTask(taskId),
    onSuccess: refreshAll,
  });
  return { startTask, setTaskStatus, convertTaskToCode, boostTask };
}

/**
 * 任务提交后悔窗口：任务从草稿提交后，N 毫秒内调度器不自动领取执行，
 * 给用户撤回的时间。提交后前端会立即尝试执行一次；只有立即执行失败
 * （执行槽被占用）时任务才排队，此窗口保证排队中的任务不会马上被调度器领走。
 */
export const SUBMIT_GRACE_MS = 15_000;

/**
 * 判断任务是否仍处于提交后悔窗口内（updatedAt 距 now 不足 SUBMIT_GRACE_MS）。
 * updatedAt 在提交时由前端更新，代表最近一次提交/退回时间；
 * 时间解析失败时保守返回 true（视为仍在窗口内），避免刚提交的任务被秒领。
 */
export function isTaskWithinSubmitGrace(updatedAt: string, now: number = Date.now()): boolean {
  const submittedAt = new Date(updatedAt).getTime();
  if (!Number.isFinite(submittedAt)) return true;
  return now - submittedAt < SUBMIT_GRACE_MS;
}

/**
 * 按项目隔离选出下一个可领取的任务：跳过已有任务在执行的项目的所有任务，
 * 从其余项目取队首任务（保持全局优先级排序）。不同项目互不阻塞，可并行执行。
 * 无可用任务时返回 undefined。
 */
export function pickNextClaimableTask(
  queued: ProjectTask[],
  runningProjectIds: ReadonlySet<string>,
): ProjectTask | undefined {
  return queued.find((task) => !runningProjectIds.has(task.projectId));
}

/**
 * 前端调度器：按固定节奏轮询「有待处理（已提交）任务」，按项目隔离领取执行。
 * 每个项目同一时刻至多一个任务在跑：跳过已有任务在执行的项目的所有任务，
 * 从其余项目的队首任务开始领取。不同项目互不阻塞，可并行执行。
 * 领取成功后 Rust 端原子地把任务推进 in_progress，前端无需手动标记状态，只负责触发。
 *
 * 后悔窗口：任务刚提交（updatedAt 太新）时不领取，避免用户没有撤回机会；
 * 只有提交超过 SUBMIT_GRACE_MS 才允许调度器自动领取。
 *
 * 领取失败（如 Agent 未安装、进程启动失败等）时，若提供了 `onClaimError` 回调则调用，
 * 让用户能看到原因，而不是任务静默卡在待处理。失败后对同一任务进入冷却，
 * 避免每 5 秒轮询反复触发同一条错误提示。
 */
export function useProjectTaskScheduler(
  autoRefresh = false,
  intervalMs = 5_000,
  onClaimError?: (message: string, taskId: string) => void,
) {
  const runnerState = useProjectTaskRunnerState(autoRefresh, intervalMs);
  const queued = useQueuedProjectTasks(autoRefresh, intervalMs);
  const actions = useProjectTaskRunnerActions();
  // StrictMode 下 effect 会同步执行两次，mutate 的 isPending 状态更新在 effect
  // 全部跑完前不会生效，需用 ref 锁防止同一个待执行任务被重复领取。
  const claimingRef = useRef(false);
  // 领取失败回调用 ref 存储，避免内联箭头函数每次渲染变化导致 effect 重跑。
  const onClaimErrorRef = useRef(onClaimError);
  onClaimErrorRef.current = onClaimError;
  // 领取失败冷却：记录「任务 id → 上次失败提示时间」，避免无限轮询刷屏。
  const lastErrorRef = useRef<{ taskId: string; at: number } | null>(null);

  useEffect(() => {
    if (!autoRefresh) return;
    if (claimingRef.current) return;
    if (actions.startTask.isPending) return;
    // 按项目隔离领取：跳过已有任务在执行的项目的所有任务，从其余项目取队首任务。
    // 不同项目可并行执行，每个项目至多一个任务在跑。
    const runningProjectIds = new Set((runnerState.data?.current ?? []).map((info) => info.projectId));
    const next = pickNextClaimableTask(queued.data ?? [], runningProjectIds);
    if (!next) return;
    // 后悔窗口：任务刚提交（updatedAt 太新）时不领取，避免用户没有撤回机会。
    if (isTaskWithinSubmitGrace(next.updatedAt)) return;
    claimingRef.current = true;
    actions.startTask.mutate({ projectId: next.projectId, taskId: next.id }, {
      onSettled: () => { claimingRef.current = false; },
      onError: (error) => {
        const handleError = onClaimErrorRef.current;
        if (!handleError) return;
        const now = Date.now();
        // 冷却窗口：同一任务短时间内只提示一次，避免每 5 秒重试刷屏。
        const last = lastErrorRef.current;
        if (last && last.taskId === next.id && now - last.at < 30_000) return;
        lastErrorRef.current = { taskId: next.id, at: now };
        handleError(error instanceof Error ? error.message : String(error), next.id);
      },
    });
    // 依赖 runnerState / queued 变化：领取后刷新看板，避免重复领取。
  }, [autoRefresh, runnerState.data, queued.data, actions.startTask.isPending, actions.startTask]);

  return { runnerState, queued, ...actions };
}

export function newProject(name: string, directoryPath: string): Project {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    name: name.trim(),
    directoryPath,
    workspaceProjectId: null,
    workspaceArchived: false,
    createdAt: now,
    updatedAt: now,
  };
}

export function newProjectTask(projectId: string, title: string, baseTaskId: string | null = null): ProjectTask {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    projectId,
    title: title.trim(),
    description: "",
    status: "draft",
    taskType: "code",
    agentProfile: "Claude Code",
    priority: "p2",
    baseTaskId,
    lastJobId: null,
    rejectionReason: null,
    executionHistory: null,
    claimedBy: null,
    queueBoostedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}
