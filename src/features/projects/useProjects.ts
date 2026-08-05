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

export function useProjectTasks(projectId: string | undefined, autoRefresh = false) {
  return useQuery({
    queryKey: queryKeys.project.tasks(projectId ?? ""),
    queryFn: () => projectCommands.listTasks(projectId!),
    enabled: Boolean(projectId),
    refetchInterval: autoRefresh ? 15_000 : false,
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

/** 全局唯一执行槽状态（是否空闲、当前在跑的任务）。 */
export function useProjectTaskRunnerState(autoRefresh = false): ReturnType<typeof useQuery<ProjectTaskRunnerState>> {
  return useQuery({
    queryKey: queryKeys.projectTaskRunner.state(),
    queryFn: () => projectCommands.getTaskRunnerState(),
    refetchInterval: autoRefresh ? 5_000 : false,
    refetchOnWindowFocus: false,
  });
}

/** 跨项目聚合的「已提交、待执行」任务（按优先级 + 创建时间排序）。 */
export function useQueuedProjectTasks(autoRefresh = false): ReturnType<typeof useQuery<ProjectTask[]>> {
  return useQuery({
    queryKey: queryKeys.projectTaskRunner.queued(),
    queryFn: () => projectCommands.listQueuedTasks(),
    refetchInterval: autoRefresh ? 10_000 : false,
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
  return { startTask, setTaskStatus, convertTaskToCode };
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
 * 前端调度器：按固定节奏轮询「执行槽空闲 && 有待处理（已提交）任务」，
 * 有空闲就领取队首任务。领取成功后 Rust 端原子地把任务推进 in_progress，
 * 前端无需手动标记状态，只负责触发。
 *
 * 后悔窗口：任务刚提交（updatedAt 太新）时不领取，避免用户没有撤回机会；
 * 只有提交超过 SUBMIT_GRACE_MS 才允许调度器自动领取。
 */
export function useProjectTaskScheduler(autoRefresh = false) {
  const runnerState = useProjectTaskRunnerState(autoRefresh);
  const queued = useQueuedProjectTasks(autoRefresh);
  const actions = useProjectTaskRunnerActions();
  // StrictMode 下 effect 会同步执行两次，mutate 的 isPending 状态更新在 effect
  // 全部跑完前不会生效，需用 ref 锁防止同一个待执行任务被重复领取。
  const claimingRef = useRef(false);

  useEffect(() => {
    if (!autoRefresh) return;
    if (claimingRef.current) return;
    if (actions.startTask.isPending) return;
    if (runnerState.data?.running) return;
    const next = queued.data?.[0];
    if (!next) return;
    // 后悔窗口：任务刚提交（updatedAt 太新）时不领取，避免用户没有撤回机会。
    if (isTaskWithinSubmitGrace(next.updatedAt)) return;
    claimingRef.current = true;
    actions.startTask.mutate({ projectId: next.projectId, taskId: next.id }, {
      onSettled: () => { claimingRef.current = false; },
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
    createdAt: now,
    updatedAt: now,
  };
}
