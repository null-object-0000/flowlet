import styles from "./AppMockup.module.css";

/** 纯 CSS 绘制的概览页风格化示意图,不伪装真实截图。 */
export function AppMockup() {
  return (
    <div className={styles.window}>
      <div className={styles.chrome}>
        <div className={styles.dots}>
          <span />
          <span />
          <span />
        </div>
        <div className={styles.title}>Flowlet Overview</div>
      </div>
      <div className={styles.body}>
        <aside className={styles.sidebar}>
          <div className={styles.brand}>
            <span className={styles.brandDot} />
            <span>Flowlet</span>
          </div>
          <div className={styles.navItems}>
            <div className={`${styles.navItem} ${styles.active}`}>Overview</div>
            <div className={styles.navItem}>Channels</div>
            <div className={styles.navItem}>Models</div>
            <div className={styles.navItem}>Agents</div>
            <div className={styles.navItem}>Logs</div>
            <div className={styles.navItem}>Settings</div>
          </div>
        </aside>
        <div className={styles.main}>
          <div className={styles.serviceStrip}>
            <div className={styles.status}>
              <span className={styles.statusDot} />
              Running
            </div>
            <div className={styles.pill}><span className={styles.muted}>Token today:</span> 1.2M</div>
            <div className={styles.pill}>127.0.0.1:18640</div>
          </div>
          <div className={styles.grid}>
            <div className={`${styles.card} ${styles.channels}`}>
              <div className={styles.cardTitle}>Channel Accounts</div>
              <div className={styles.accountRow}>
                <span className={styles.dotGreen} />
                LongCat · enabled
              </div>
              <div className={styles.accountRow}>
                <span className={styles.dotGreen} />
                DeepSeek · enabled
              </div>
              <div className={styles.accountRow}>
                <span className={styles.dotGray} />
                Kimi · disabled
              </div>
            </div>
            <div className={styles.card}>
              <div className={styles.cardTitle}>Exposed Models</div>
              <div className={styles.modelPills}>
                <span>longcat-2.0</span>
                <span>deepseek-v4-pro</span>
                <span>qwen3.7-max</span>
              </div>
            </div>
            <div className={`${styles.card} ${styles.agent}`}>
              <div className={styles.cardTitle}>AI Agent Access</div>
              <div className={styles.agentIcons}>
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
