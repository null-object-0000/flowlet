import type { SharedDeviceProject, SyncedProjectTask } from "../../domains/device-sync/types";
import type { Project, ProjectTask, ProjectTaskPriority, ProjectTaskStatus } from "../../domains/project/types";

export type RemoteTaskOrigin = {
  deviceId: string;
  deviceDisplayName: string;
  devicePlatform: string;
  projectId: string;
  snapshotUpdatedAt: string;
};

export type MergedProjectTasks = {
  tasks: ProjectTask[];
  remoteOrigins: Map<string, RemoteTaskOrigin>;
};

const TASK_STATUSES = new Set<ProjectTaskStatus>(["draft", "submitted", "in_progress", "review", "done"]);
const TASK_PRIORITIES = new Set<ProjectTaskPriority>(["p0", "p1", "p2"]);

function normalizedProjectName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function matchesProject(project: Project, shared: SharedDeviceProject): boolean {
  if (project.workspaceProjectId && project.workspaceProjectId === shared.projectId) return true;
  return normalizedProjectName(project.name) === normalizedProjectName(shared.projectName);
}

function taskTimestamp(task: SyncedProjectTask): number {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function toProjectTask(task: SyncedProjectTask, projectId: string): ProjectTask {
  return {
    id: task.id,
    projectId,
    title: task.title,
    description: "",
    status: TASK_STATUSES.has(task.status as ProjectTaskStatus) ? task.status as ProjectTaskStatus : "draft",
    taskType: "readonly",
    agentProfile: "",
    priority: TASK_PRIORITIES.has(task.priority as ProjectTaskPriority) ? task.priority as ProjectTaskPriority : "p2",
    baseTaskId: null,
    lastJobId: null,
    rejectionReason: null,
    executionHistory: null,
    claimedBy: null,
    queueBoostedAt: null,
    createdAt: task.updatedAt,
    updatedAt: task.updatedAt,
  };
}

/**
 * 在展示层合并本机事实任务与其他设备的只读快照。
 *
 * - 本机任务始终优先，绝不被设备快照覆盖；
 * - 同一远端任务出现在多个设备时，展示更新时间最新的一份；
 * - 项目优先按 workspaceProjectId 匹配，并用同名项目兼容各设备独立创建的旧数据。
 */
export function mergeProjectTasks(
  project: Project,
  localTasks: ProjectTask[],
  sharedProjects: SharedDeviceProject[],
): MergedProjectTasks {
  const localIds = new Set(localTasks.map((task) => task.id));
  const remoteTasks = new Map<string, { task: SyncedProjectTask; origin: RemoteTaskOrigin }>();

  for (const shared of sharedProjects) {
    if (!matchesProject(project, shared)) continue;
    for (const task of shared.tasks) {
      if (localIds.has(task.id)) continue;
      const current = remoteTasks.get(task.id);
      if (current && taskTimestamp(current.task) > taskTimestamp(task)) continue;
      remoteTasks.set(task.id, {
        task,
        origin: {
          deviceId: shared.deviceId,
          deviceDisplayName: shared.deviceDisplayName,
          devicePlatform: shared.devicePlatform,
          projectId: shared.projectId,
          snapshotUpdatedAt: shared.updatedAt,
        },
      });
    }
  }

  const remoteOrigins = new Map<string, RemoteTaskOrigin>();
  const merged = [...localTasks];
  for (const { task, origin } of remoteTasks.values()) {
    merged.push(toProjectTask(task, project.id));
    remoteOrigins.set(task.id, origin);
  }
  return { tasks: merged, remoteOrigins };
}
