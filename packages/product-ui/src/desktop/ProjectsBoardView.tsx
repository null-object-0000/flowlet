import styles from "./ProjectsBoardView.module.css";

export type ProjectsBoardTaskModel = {
  id: string;
  project: string;
  title: string;
  agentLabel: string;
  agentIcon?: string;
  running?: boolean;
  progress?: number;
  meta?: string;
};

export type ProjectsBoardColumnModel = {
  id: string;
  title: string;
  count: number;
  tasks: ProjectsBoardTaskModel[];
};

export type ProjectsBoardLabels = {
  emptyHint: string;
  running: string;
};

type Props = {
  columns: ProjectsBoardColumnModel[];
  labels: ProjectsBoardLabels;
  density?: "default" | "compact";
  onOpenTask?: (id: string) => void;
};

export function ProjectsBoardView({ columns, labels, density = "default", onOpenTask }: Props) {
  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      <div className={styles.board}>
        {columns.map((column) => (
          <section className={styles.boardColumn} key={column.id}>
            <header className={styles.columnHeader}>
              <span className={styles.columnTitle}>{column.title}</span>
              <span className={styles.columnCount}>{column.count}</span>
            </header>
            <div className={styles.columnBody}>
              {column.tasks.map((task) => (
                <article
                  key={task.id}
                  className={styles.taskCard}
                  role={onOpenTask ? "button" : undefined}
                  tabIndex={onOpenTask ? 0 : undefined}
                  onClick={() => onOpenTask?.(task.id)}
                >
                  <small className={styles.taskProject}>{task.project}</small>
                  <strong className={styles.taskTitle}>{task.title}</strong>
                  <div className={styles.taskMeta}>
                    <span className={styles.taskAgent}>
                      {task.agentIcon ? <img src={task.agentIcon} alt="" /> : null}
                      {task.agentLabel}
                    </span>
                    {task.running ? <i className={styles.runningDot} /> : null}
                  </div>
                  {task.meta ? <small className={styles.taskTime}>{task.meta}</small> : null}
                  {task.running ? (
                    <div className={styles.progress}><span style={{ width: `${task.progress ?? 0}%` }} /></div>
                  ) : null}
                </article>
              ))}
              {column.tasks.length === 0 ? <div className={styles.emptyHint}>{labels.emptyHint}</div> : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
