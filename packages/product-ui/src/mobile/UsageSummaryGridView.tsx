import styles from "./UsageSummaryGridView.module.css";

export type UsageSummaryItem = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  actionLabel?: string;
  onClick?: () => void;
};

type Props = {
  items: UsageSummaryItem[];
  columns?: 2 | 3 | 4;
  density?: "default" | "compact";
};

export function UsageSummaryGridView({ items, columns = 2, density = "default" }: Props) {
  return (
    <div className={`${styles.grid} ${styles[`columns${columns}`]} ${density === "compact" ? styles.compact : ""}`}>
      {items.map((item) => {
        const content = <><span>{item.label}</span><strong>{item.value}</strong>{item.detail ? <small>{item.detail}</small> : null}</>;
        return item.onClick ? (
          <button key={item.id} type="button" className={styles.item} onClick={item.onClick} title={item.actionLabel}>{content}</button>
        ) : (
          <article key={item.id} className={styles.item}>{content}</article>
        );
      })}
    </div>
  );
}
