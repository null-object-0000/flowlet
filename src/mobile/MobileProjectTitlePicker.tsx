import { IconChevronDown } from "@douyinfe/semi-icons";
import { Dropdown } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import type { MobileProjectGroup } from "./groupMobileProjects";
import styles from "./MobileDevicePicker.module.css";

/** 标题形态项目切换器：与概览页设备标题切换器同款样式，用于在逻辑项目间切换。 */
export function MobileProjectTitlePicker({
  groups,
  selectedKey,
  onChange,
  formatTitle,
}: {
  groups: MobileProjectGroup[];
  selectedKey: string | null;
  /** 由页面决定标题文案：未选中时收到 null。 */
  formatTitle: (projectName: string | null) => string;
  onChange: (key: string) => void;
}) {
  const { t } = useAppPreferences();
  const selectedName = groups.find((group) => group.key === selectedKey)?.projectName ?? null;
  const ariaName = selectedName ?? "…";

  return (
    <Dropdown
      position="bottomLeft"
      trigger="click"
      clickToHide
      render={(
        <Dropdown.Menu>
          {groups.map((group) => (
            <Dropdown.Item
              key={group.key}
              active={group.key === selectedKey}
              onClick={() => onChange(group.key)}
            >
              <div className={styles.projectOption}>
                <strong className={styles.projectOptionName}>{group.projectName}</strong>
                <small className={styles.projectOptionMeta}>
                  {t("{count} 台设备", { count: group.devices.length })}
                </small>
              </div>
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      )}
    >
      <button
        type="button"
        className={styles.titleTrigger}
        aria-label={t("切换项目，当前：{name}", { name: ariaName })}
      >
        <span>{formatTitle(selectedName)}</span>
        <IconChevronDown />
      </button>
    </Dropdown>
  );
}
