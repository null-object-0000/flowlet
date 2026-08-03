import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { projectCommands } from "../../domains/project/commands";
import type { Project, ProjectTask } from "../../domains/project/types";
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

export function useProjectTasks(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.project.tasks(projectId ?? ""),
    queryFn: () => projectCommands.listTasks(projectId!),
    enabled: Boolean(projectId),
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

export function newProject(name: string, directoryPath: string): Project {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), name: name.trim(), directoryPath, createdAt: now, updatedAt: now };
}

export function newProjectTask(projectId: string, title: string): ProjectTask {
  const now = new Date().toISOString();
  return { id: crypto.randomUUID(), projectId, title: title.trim(), description: "", status: "todo", createdAt: now, updatedAt: now };
}
