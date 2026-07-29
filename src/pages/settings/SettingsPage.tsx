import { useEffect, useMemo, useRef, useState } from "react";
import { IconSearch } from "@douyinfe/semi-icons";
import { Typography } from "@douyinfe/semi-ui-19";
import { AboutTab } from "./tabs/AboutTab";
import { CaptureTab } from "./tabs/CaptureTab";
import { GeneralTab } from "./tabs/GeneralTab";
import { MaintenanceTab } from "./tabs/MaintenanceTab";
import { StorageTab } from "./tabs/StorageTab";
import { SyncTab } from "./tabs/SyncTab";
import styles from "./SettingsPage.module.css";
import { SettingsNav, useSettingsTabMeta, type SettingsTab } from "./SettingsNav";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Paragraph, Title } = Typography;

const TAB_COMPONENTS: Record<SettingsTab, React.ComponentType> = {
  general: GeneralTab,
  capture: CaptureTab,
  sync: SyncTab,
  storage: StorageTab,
  maintenance: MaintenanceTab,
  about: AboutTab,
};

export function SettingsPage() {
  const { t } = useAppPreferences();
  const [tab, setTab] = useState<SettingsTab>("general");
  const [query, setQuery] = useState("");
  const panelBodyRef = useRef<HTMLDivElement>(null);
  const tabMeta = useSettingsTabMeta();

  const activeComponent = TAB_COMPONENTS[tab];
  const ActiveTab = activeComponent;

  useEffect(() => {
    if (panelBodyRef.current) {
      panelBodyRef.current.scrollTop = 0;
    }
    setQuery("");
  }, [tab]);

  const searchEmpty = useMemo(() => {
    if (!query.trim()) return false;
    const panel = panelBodyRef.current;
    if (!panel) return false;
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>("[data-keywords]"));
    return nodes.every((el) => el.style.display === "none");
  }, [query, tab]);

  useEffect(() => {
    const panel = panelBodyRef.current;
    if (!panel) return;
    const q = query.trim().toLowerCase();
    const nodes = Array.from(panel.querySelectorAll<HTMLElement>("[data-keywords]"));
    if (!q) {
      nodes.forEach((el) => {
        el.style.display = "";
      });
      return;
    }
    nodes.forEach((el) => {
      const hay = `${el.dataset.keywords ?? ""} ${el.textContent ?? ""}`.toLowerCase();
      el.style.display = hay.includes(q) ? "" : "none";
    });
  }, [query, tab]);

  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <main className={styles.page}>
      <header className={styles.pageHead}>
        <div>
          <Title heading={3}>{t("应用设置")}</Title>
          <Paragraph>{t("管理应用偏好、本地数据与安全策略")}</Paragraph>
        </div>
        <div className={styles.headActions}>
          <label className={styles.searchBox}>
            <IconSearch style={{ width: 15, height: 15 }} />
            <input
              ref={searchInputRef}
              placeholder={t("搜索设置")}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
        </div>
      </header>

      <section className={styles.shell}>
        <SettingsNav active={tab} onChange={setTab} />
        <article className={styles.contentPanel}>
          <div className={styles.panelHead}>
            <div>
              <h2 className={styles.panelTitle}>{tabMeta[tab].title}</h2>
              <p className={styles.panelDesc}>{tabMeta[tab].desc}</p>
            </div>
          </div>
          <div className={styles.panelBody} ref={panelBodyRef}>
            <ActiveTab />
            <div className={`${styles.searchEmpty} ${searchEmpty ? styles.show : ""}`}>
              <IconSearch style={{ width: 34, height: 34 }} />
              <strong>{t("没有找到相关设置")}</strong>
              <p>{t("换一个关键词试试，例如“Body”“备份”或“主题”")}</p>
            </div>
          </div>
        </article>
      </section>
    </main>
  );
}
