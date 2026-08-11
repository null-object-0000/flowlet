import { useMemo, useState } from "react";
import { Button, Progress, Select, Tag } from "@douyinfe/semi-ui-19";
import { IconDelete } from "@douyinfe/semi-icons";
import { DemoPageScaffold, DemoRefreshControl } from "./DemoPageScaffold";
import styles from "./TaskLogsDemoView.module.css";

type DemoTask = {
  id: string;
  createdAt: string;
  title: string;
  stage: string;
  trigger: "manual" | "background" | "file";
  progress: number;
  duration: string;
  status: "running" | "success" | "warning" | "failed";
};

const TASKS: DemoTask[] = [
  { id: "sync-models", createdAt: "今天 10:42:18", title: "渠道资源自动同步", stage: "正在同步 Qwen · Token Plan", trigger: "background", progress: 68, duration: "1m 24s", status: "running" },
  { id: "project-run", createdAt: "今天 10:31:06", title: "官网产品能力核对", stage: "Codex · 代码修改", trigger: "manual", progress: 100, duration: "8m 16s", status: "success" },
  { id: "agent-sync", createdAt: "今天 09:58:47", title: "Agent 会话目录同步", stage: "扫描 4 个本地 Agent", trigger: "file", progress: 100, duration: "3.8s", status: "success" },
  { id: "codex-sync", createdAt: "今天 09:42:10", title: "Codex 账号用量同步", stage: "1 个账号缺少订阅数据", trigger: "background", progress: 100, duration: "2.1s", status: "warning" },
  { id: "s3-sync", createdAt: "昨天 23:58:00", title: "S3 设备数据同步", stage: "办公室电脑 · 上传用量分片", trigger: "background", progress: 100, duration: "6.4s", status: "success" },
];

export function TaskLogsDemoView({ zh }: { zh: boolean }) {
  const [status, setStatus] = useState("all");
  const [selected, setSelected] = useState(TASKS[0].id);
  const rows = useMemo(() => status === "all" ? TASKS : TASKS.filter((task) => task.status === status), [status]);
  const active = TASKS.find((task) => task.id === selected) ?? TASKS[0];

  return <DemoPageScaffold
    title={zh ? "任务日志" : "Tasks"}
    subtitle={zh ? "查看后台处理任务的进度、性能、结果与错误" : "Inspect background task progress, performance, results and errors"}
    controls={<DemoRefreshControl zh={zh} />}
  >
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <Select
          value={status}
          aria-label={zh ? "状态" : "Status"}
          optionList={[
            { value: "all", label: zh ? "全部状态" : "All statuses" },
            { value: "running", label: zh ? "运行中" : "Running" },
            { value: "success", label: zh ? "成功" : "Succeeded" },
            { value: "warning", label: zh ? "部分失败" : "Warnings" },
          ]}
          onChange={(value) => setStatus(String(value))}
        />
        <Select value="all" aria-label={zh ? "任务类型" : "Task type"} optionList={[{ value: "all", label: zh ? "全部类型" : "All types" }]} />
        <Select value="all" aria-label={zh ? "触发方式" : "Trigger"} optionList={[{ value: "all", label: zh ? "全部触发方式" : "All triggers" }]} />
        <span />
        <Button type="tertiary" theme="outline" icon={<IconDelete />}>{zh ? "清理日志" : "Clean logs"}</Button>
      </div>
      <div className={styles.workspace}>
        <section className={styles.tableCard}>
          <div className={`${styles.grid} ${styles.head}`}><span>{zh ? "创建时间" : "Created"}</span><span>{zh ? "任务" : "Task"}</span><span>{zh ? "触发" : "Trigger"}</span><span>{zh ? "进度" : "Progress"}</span><span>{zh ? "耗时" : "Duration"}</span><span>{zh ? "状态" : "Status"}</span></div>
          <div className={styles.body}>
            {rows.map((task) => <button key={task.id} type="button" className={`${styles.grid} ${styles.row} ${task.id === selected ? styles.selected : ""}`} onClick={() => setSelected(task.id)}>
              <span>{zh ? task.createdAt : task.createdAt.replace("今天", "Today").replace("昨天", "Yesterday")}</span>
              <span className={styles.task}><strong>{task.title}</strong><small>{task.stage}</small></span>
              <span>{triggerLabel(task.trigger, zh)}</span><span>{task.progress}%</span><span>{task.duration}</span><span><Status task={task} zh={zh} /></span>
            </button>)}
          </div>
          <footer><span>{zh ? `共 ${rows.length} 条` : `${rows.length} tasks`}</span><span>1 / 1</span></footer>
        </section>
        <aside className={styles.detail}>
          <div className={styles.detailHead}><div><strong>{active.title}</strong><span>{active.createdAt} · {triggerLabel(active.trigger, zh)}</span></div><Status task={active} zh={zh} /></div>
          <section><div className={styles.progressTitle}><strong>{active.stage}</strong><span>{active.progress}%</span></div><Progress percent={active.progress} showInfo={false} /></section>
          <section><h3>{zh ? "性能指标" : "Performance"}</h3><div className={styles.metrics}><span><small>{zh ? "总耗时" : "Duration"}</small><strong>{active.duration}</strong></span><span><small>{zh ? "处理对象" : "Objects"}</small><strong>7</strong></span><span><small>{zh ? "成功" : "Succeeded"}</small><strong>6</strong></span></div></section>
          <section><h3>{zh ? "处理记录" : "Activity"}</h3><div className={styles.timeline}><p><i />{zh ? "任务已创建并进入处理队列" : "Task queued"}</p><p><i />{active.stage}</p><p><i className={styles.activeDot} />{active.status === "running" ? (zh ? "正在等待上游返回" : "Waiting for upstream") : (zh ? "处理完成" : "Completed")}</p></div></section>
        </aside>
      </div>
    </div>
  </DemoPageScaffold>;
}

function triggerLabel(trigger: DemoTask["trigger"], zh: boolean) {
  if (trigger === "manual") return zh ? "手动" : "Manual";
  if (trigger === "file") return zh ? "文件变化" : "File watch";
  return zh ? "后台自动" : "Background";
}

function Status({ task, zh }: { task: DemoTask; zh: boolean }) {
  const labels = { running: zh ? "运行中" : "Running", success: zh ? "成功" : "Succeeded", warning: zh ? "部分失败" : "Warnings", failed: zh ? "失败" : "Failed" };
  const colors = { running: "blue", success: "green", warning: "orange", failed: "red" } as const;
  return <Tag size="small" color={colors[task.status]}>{labels[task.status]}</Tag>;
}
