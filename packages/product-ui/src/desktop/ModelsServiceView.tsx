import styles from "./ModelsServiceView.module.css";

export type ModelsServiceStatModel = {
  key: string;
  label: string;
  value: string;
  tone?: "default" | "success";
};

export type ModelsServiceItemModel = {
  id: string;
  kind: "aggregate" | "direct";
  name: string;
  typeLabel: string;
  summary: string;
  summaryMuted?: boolean;
  enabled: boolean;
  logo?: string;
};

export type ModelsServiceLabels = {
  stats: Record<string, string>;
  aggregateGroup: string;
  directGroup: string;
  currentVisible: string;
  hint: string;
  ready: string;
  off: string;
};

type Props = {
  stats: ModelsServiceStatModel[];
  groups: { aggregate: ModelsServiceItemModel[]; direct: ModelsServiceItemModel[] };
  labels: ModelsServiceLabels;
  density?: "default" | "compact";
  onSelect?: (id: string) => void;
  selectedId?: string | null;
};

export function ModelsServiceView({ stats, groups, labels, density = "default", onSelect, selectedId }: Props) {
  const renderRow = (model: ModelsServiceItemModel) => (
    <div
      key={model.id}
      className={`${styles.modelRow} ${selectedId === model.id ? styles.selected : ""}`}
    >
      <button
        type="button"
        className={styles.modelRowMain}
        aria-pressed={selectedId === model.id}
        onClick={() => onSelect?.(model.id)}
      >
        <span className={styles.modelName}>
          {model.logo ? <img className={styles.modelLogo} src={model.logo} alt="" /> : <span className={styles.modelLogoFallback} />}
          <span><strong>{model.name}</strong><small>{model.typeLabel}</small></span>
        </span>
        <span className={`${styles.routeSummary} ${model.summaryMuted ? styles.routeSummaryMuted : ""}`}>{model.summary}</span>
      </button>
      <span className={`${styles.status} ${model.enabled ? styles.statusOn : ""}`}>
        <i />{model.enabled ? labels.ready : labels.off}
      </span>
    </div>
  );

  return (
    <div className={`${styles.page} ${density === "compact" ? styles.compact : ""}`}>
      <section className={styles.statsBar} aria-label="model stats">
        {stats.map((stat) => (
          <div className={styles.stat} key={stat.key}>
            <span>{stat.label}</span>
            <strong className={stat.tone === "success" ? styles.statSuccess : ""}>{stat.value}</strong>
          </div>
        ))}
      </section>

      <section className={styles.listCard}>
        <div className={styles.modelList}>
          {groups.aggregate.length > 0 ? (
            <>
              <div className={styles.groupTitle}>{labels.aggregateGroup}<span className={styles.groupCount}>{groups.aggregate.length}</span></div>
              {groups.aggregate.map(renderRow)}
            </>
          ) : null}
          {groups.direct.length > 0 ? (
            <>
              <div className={styles.groupTitle}>{labels.directGroup}<span className={styles.groupCount}>{groups.direct.length}</span></div>
              {groups.direct.map(renderRow)}
            </>
          ) : null}
        </div>
        <footer className={styles.listFooter}>
          <span>{labels.currentVisible}</span>
          <span>{labels.hint}</span>
        </footer>
      </section>
    </div>
  );
}
