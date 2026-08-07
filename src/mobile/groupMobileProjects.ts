import type { SharedDeviceProject, SyncedProjectTask } from "../domains/device-sync/types";

/** 跨设备聚合后的逻辑项目：同一工作区项目在多台设备上的快照合并成一个。 */
export type MobileProjectGroup = {
  /** 稳定 key（取组内第一个项目的 projectId，同名不同 id 的旧数据共用该 key）。 */
  key: string;
  /** 工作区项目 id（提交任务时使用）。 */
  projectId: string;
  projectName: string;
  /** 组内最近一次项目更新时间，用于项目切换列表排序。 */
  updatedAt: string;
  /** 承载该项目的设备快照。 */
  devices: SharedDeviceProject[];
  /** 全部设备的任务合并（按任务 id 去重，保留更新时间最新的一份），按更新时间倒序。 */
  tasks: Array<{ task: SyncedProjectTask; project: SharedDeviceProject }>;
};

/**
 * 把全部设备的项目快照聚合成逻辑项目列表，供移动端项目页按「单个项目」查看跨设备任务。
 *
 * 合并规则与 PC 看板 `mergeProjectTasks` 一致：优先按 workspaceProjectId 匹配，
 * 并用同名项目兼容各设备独立创建的旧数据；同一任务出现在多个设备时展示更新时间最新的一份。
 */
export function groupMobileProjects(projects: SharedDeviceProject[]): MobileProjectGroup[] {
  const groups = new Map<string, MobileProjectGroup>();
  const keyById = new Map<string, string>();
  const keyByName = new Map<string, string>();

  for (const project of projects) {
    let key = keyById.get(project.projectId) ?? keyByName.get(normalizedName(project.projectName));
    if (!key) {
      key = project.projectId || project.projectName;
      groups.set(key, {
        key,
        projectId: project.projectId,
        projectName: project.projectName,
        updatedAt: project.updatedAt,
        devices: [],
        tasks: [],
      });
      keyById.set(project.projectId, key);
      keyByName.set(normalizedName(project.projectName), key);
    }
    const group = groups.get(key)!;
    group.devices.push(project);
    if (project.updatedAt > group.updatedAt) group.updatedAt = project.updatedAt;
    for (const task of project.tasks) {
      const existing = group.tasks.find((item) => item.task.id === task.id);
      if (existing) {
        if (taskTimestamp(task) > taskTimestamp(existing.task)) {
          existing.task = task;
          existing.project = project;
        }
      } else {
        group.tasks.push({ task, project });
      }
    }
  }

  const result = [...groups.values()];
  // 项目按最近更新倒序（活跃项目靠前）；任务按更新时间倒序。
  result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  for (const group of result) {
    group.tasks.sort((a, b) => b.task.updatedAt.localeCompare(a.task.updatedAt));
  }
  return result;
}

function normalizedName(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function taskTimestamp(task: SyncedProjectTask): number {
  const timestamp = Date.parse(task.updatedAt);
  return Number.isNaN(timestamp) ? 0 : timestamp;
}
