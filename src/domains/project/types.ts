export type Project = {
  id: string;
  name: string;
  directoryPath: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTaskStatus = "draft" | "submitted" | "in_progress" | "review" | "done";

export type ProjectTaskType = "code" | "readonly";

export type ProjectTaskPriority = "p0" | "p1" | "p2" | "p3";

export type ProjectTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: ProjectTaskStatus;
  taskType: ProjectTaskType;
  agentProfile: string;
  priority: ProjectTaskPriority;
  createdAt: string;
  updatedAt: string;
};
