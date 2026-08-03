export type Project = {
  id: string;
  name: string;
  directoryPath: string;
  createdAt: string;
  updatedAt: string;
};

export type ProjectTaskStatus = "todo" | "in_progress" | "done";

export type ProjectTask = {
  id: string;
  projectId: string;
  title: string;
  description: string;
  status: ProjectTaskStatus;
  createdAt: string;
  updatedAt: string;
};
