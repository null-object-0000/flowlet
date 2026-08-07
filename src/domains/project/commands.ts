import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type {
  Project,
  ProjectTask,
  ProjectTaskMutableStatus,
  ProjectTaskRunnerState,
  ProjectWorkspaceStatus,
  ProjectWorkspaceSyncResult,
  RunProjectTaskResult,
} from "./types";

const wrap = (error: unknown) => { throw toAppError(error, "project_operation_failed"); };

export const projectCommands = {
  list: (): Promise<Project[]> => invokeCommand<Project[]>("list_projects").catch(wrap),
  get: (projectId: string): Promise<Project> => invokeCommand<Project>("get_project", { projectId }).catch(wrap),
  save: (project: Project): Promise<void> => invokeCommand<void>("save_project", { project }).catch(wrap),
  delete: (projectId: string): Promise<boolean> => invokeCommand<boolean>("delete_project", { projectId }).catch(wrap),
  listTasks: (projectId: string): Promise<ProjectTask[]> => invokeCommand<ProjectTask[]>("list_project_tasks", { projectId }).catch(wrap),
  saveTask: (task: ProjectTask): Promise<void> => invokeCommand<void>("save_project_task", { task }).catch(wrap),
  deleteTask: (projectId: string, taskId: string): Promise<boolean> => invokeCommand<boolean>("delete_project_task", { projectId, taskId }).catch(wrap),
  runTask: (projectId: string, taskId: string): Promise<RunProjectTaskResult> => invokeCommand<RunProjectTaskResult>("run_project_task", { projectId, taskId }).catch(wrap),
  getTaskRunnerState: (): Promise<ProjectTaskRunnerState> => invokeCommand<ProjectTaskRunnerState>("get_project_task_runner_state").catch(wrap),
  listQueuedTasks: (): Promise<ProjectTask[]> => invokeCommand<ProjectTask[]>("list_queued_project_tasks").catch(wrap),
  boostTask: (taskId: string): Promise<boolean> => invokeCommand<boolean>("boost_project_task", { taskId }).catch(wrap),
  setTaskStatus: (taskId: string, status: ProjectTaskMutableStatus, reason?: string): Promise<void> => invokeCommand<void>("set_project_task_status", { taskId, status, reason: reason ?? null }).catch(wrap),
  convertTaskToCode: (taskId: string, description: string): Promise<void> => invokeCommand<void>("convert_project_task_to_code", { taskId, description }).catch(wrap),
  openDetailWindow: (projectId: string): Promise<void> => invokeCommand<void>("open_project_detail_window", { projectId }).catch(wrap),
  getWorkspaceStatus: (): Promise<ProjectWorkspaceStatus> => invokeCommand<ProjectWorkspaceStatus>("get_project_workspace_status").catch(wrap),
  syncWorkspace: (): Promise<ProjectWorkspaceSyncResult> => invokeCommand<ProjectWorkspaceSyncResult>("sync_project_workspace", undefined, Number.POSITIVE_INFINITY).catch(wrap),
};
