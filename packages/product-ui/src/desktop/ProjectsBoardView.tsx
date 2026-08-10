import type { ReactNode } from "react";
import styles from "./ProjectsBoardView.module.css";

export type ProjectsBoardTaskModel = {
  id: string;
  title: string;
  roundLabel: string;
  contextLabel: string;
  status: "queued" | "running" | "review" | "done";
  meta?: string;
  trailing?: string;
};

export type ProjectsBoardColumnTone = "primary" | "warning" | "success" | "neutral";

export type ProjectsBoardAddAction = {
  label: string;
  icon?: ReactNode;
  onClick: () => void;
};

export type ProjectsBoardColumnModel = {
  id: string;
  title: string;
  count: number;
  tone?: ProjectsBoardColumnTone;
  tasks?: ProjectsBoardTaskModel[];
  content?: ReactNode;
  addAction?: ProjectsBoardAddAction;
};

export type ProjectsBoardLabels = {
  emptyHint: string;
  running: string;
};

type Props = {
  columns: ProjectsBoardColumnModel[];
  labels: ProjectsBoardLabels;
  density?: "default" | "compact";
  columnCount?: number;
  columnMinWidth?: number;
  emptyState?: ReactNode;
  boardRef?: React.Ref<HTMLDivElement>;
  onOpenTask?: (id: string) => void;
};

export type ProjectsBoardTaskCardClassNames = {
  card?: string;
  review?: string;
  head?: string;
  tags?: string;
  title?: string;
  titleStandalone?: string;
  footer?: string;
  meta?: string;
};

type TaskCardProps = {
  review?: boolean;
  tags: ReactNode;
  title: ReactNode;
  menu?: ReactNode;
  base?: ReactNode;
  blocker?: ReactNode;
  meta?: ReactNode;
  trailing?: ReactNode;
  children?: ReactNode;
  classNames?: ProjectsBoardTaskCardClassNames;
  role?: "button";
  tabIndex?: number;
  onClick?: () => void;
  onKeyDown?: React.KeyboardEventHandler<HTMLElement>;
};

const classList = (...names: Array<string | undefined | false>) => names.filter(Boolean).join(" ");

export function ProjectsBoardTaskCardView({
  review = false,
  tags,
  title,
  menu,
  base,
  blocker,
  meta,
  trailing,
  children,
  classNames = {},
  ...articleProps
}: TaskCardProps) {
  return (
    <article
      {...articleProps}
      className={classList(styles.taskCard, classNames.card, review && styles.taskCardReview, review && classNames.review)}
    >
      <div className={classList(styles.taskHead, classNames.head)}>
        <div className={classList(styles.taskTags, classNames.tags)}>{tags}</div>
        {menu}
      </div>
      <div className={classList(styles.taskTitle, classNames.title, classNames.titleStandalone)}>{title}</div>
      {base}
      {blocker}
      {meta || trailing ? (
        <div className={classList(styles.taskFooter, classNames.footer)}>
          <span className={classList(styles.taskMeta, classNames.meta)}>{meta}</span>
          {trailing}
        </div>
      ) : null}
      {children}
    </article>
  );
}

export function ProjectsBoardView({
  columns,
  labels,
  density = "default",
  columnCount = columns.length,
  columnMinWidth = 240,
  emptyState,
  boardRef,
  onOpenTask,
}: Props) {
  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      <div
        ref={boardRef}
        className={styles.board}
        style={{ gridTemplateColumns: `repeat(${columnCount}, minmax(${columnMinWidth}px, 1fr))` }}
      >
        {emptyState ? <div className={styles.boardEmpty}>{emptyState}</div> : columns.map((column) => (
          <section className={styles.boardColumn} key={column.id}>
            <header className={styles.columnHeader}>
              <span className={styles.columnTitle}>
                <span>{column.title}</span>
                <span className={`${styles.columnCount} ${styles[`columnCount_${column.tone ?? "neutral"}`]}`}>{column.count}</span>
              </span>
              {column.addAction ? (
                <button
                  type="button"
                  className={styles.columnAdd}
                  aria-label={column.addAction.label}
                  title={column.addAction.label}
                  onClick={column.addAction.onClick}
                >
                  {column.addAction.icon ?? "+"}
                </button>
              ) : null}
            </header>
            <div className={styles.columnBody}>
              {column.content ?? column.tasks?.map((task) => (
                <ProjectsBoardTaskCardView
                  key={task.id}
                  review={task.status === "review"}
                  tags={(
                    <>
                      <span className={styles.roundTag}>{task.roundLabel}</span>
                      <span className={styles.contextLabel}>{task.contextLabel}</span>
                    </>
                  )}
                  title={<strong>{task.title}</strong>}
                  meta={task.meta}
                  trailing={task.trailing ? <span className={styles.taskTrailing}>{task.trailing}</span> : null}
                  role={onOpenTask ? "button" : undefined}
                  tabIndex={onOpenTask ? 0 : undefined}
                  onClick={() => onOpenTask?.(task.id)}
                  onKeyDown={(event) => {
                    if (onOpenTask && (event.key === "Enter" || event.key === " ")) {
                      event.preventDefault();
                      onOpenTask(task.id);
                    }
                  }}
                />
              ))}
              {!column.content && (column.tasks?.length ?? 0) === 0 ? <div className={styles.emptyHint}>{labels.emptyHint}</div> : null}
              {column.addAction ? (
                <button type="button" className={styles.addCard} onClick={column.addAction.onClick}>
                  {column.addAction.icon ?? "+"}
                  <span>{column.addAction.label}</span>
                </button>
              ) : null}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
