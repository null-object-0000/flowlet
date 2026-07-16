import { Switch, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconDesktop, IconGlobe, IconMoon, IconSun, IconTick } from "@douyinfe/semi-icons";
import type { ReactNode } from "react";
import { useAppPreferences, type ThemePreference } from "../../app/preferences/AppPreferences";
import type { AppLanguage } from "../../app/preferences/translations";
import { useAutostartSetting } from "../../features/settings/useAutostartSetting";
import styles from "./SettingsPageStatic.module.css";

const { Paragraph, Title } = Typography;

export function SettingsPage() {
  const { language, setLanguage, theme, setTheme, t } = useAppPreferences();
  const autostart = useAutostartSetting();

  async function updateAutostart(checked: boolean) {
    try {
      const enabled = await autostart.mutation.mutateAsync(checked);
      Toast.success(t(enabled ? "开机启动已启用" : "开机启动已关闭"));
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
      Toast.error(t("更新开机启动失败：{message}", { message }));
    }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Title heading={3} style={{ margin: 0 }}>{t("应用设置")}</Title>
        <Paragraph type="tertiary" style={{ margin: 0 }}>{t("管理 Flowlet 的显示语言、外观和系统启动行为")}</Paragraph>
      </header>

      <div className={styles.content}>
        <SettingSection title={t("显示语言")} description={t("选择界面显示语言，修改后立即生效")} icon={<IconGlobe />}>
          <div className={styles.optionGrid}>
            <ChoiceCard selected={language === "zh-CN"} title={t("简体中文")} description={t("中文界面")} onClick={() => setLanguage("zh-CN")} />
            <ChoiceCard selected={language === "en-US"} title="English" description={t("英文界面")} onClick={() => setLanguage("en-US")} />
          </div>
        </SettingSection>

        <SettingSection title={t("界面外观")} description={t("选择系统、浅色或深色主题")} icon={<IconSun />}>
          <div className={styles.themeGrid}>
            <ThemeCard value="system" current={theme} icon={<IconDesktop />} title={t("跟随系统")} description={t("根据操作系统的外观设置自动切换")} onChange={setTheme} />
            <ThemeCard value="light" current={theme} icon={<IconSun />} title={t("浅色模式")} description={t("始终使用浅色外观")} onChange={setTheme} />
            <ThemeCard value="dark" current={theme} icon={<IconMoon />} title={t("深色模式")} description={t("始终使用深色外观")} onChange={setTheme} />
          </div>
        </SettingSection>

        <SettingSection title={t("系统")} description={t("配置 Flowlet 的系统启动行为")} icon={<IconDesktop />}>
          <div className={styles.switchRow}>
            <span>
              <strong>{t("开机启动")}</strong>
              <small>{t("登录系统后在后台启动 Flowlet，代理服务会继续按应用规则自动启动")}</small>
              {autostart.query.isError ? <button type="button" onClick={() => void autostart.query.refetch()}>{t("读取开机启动状态失败")} · {t("重试")}</button> : null}
            </span>
            <Switch
              aria-label={t("开机启动")}
              checked={autostart.query.data ?? false}
              loading={autostart.query.isLoading || autostart.mutation.isPending}
              disabled={autostart.query.isError}
              onChange={(checked) => void updateAutostart(checked)}
            />
          </div>
        </SettingSection>
      </div>
    </main>
  );
}

function SettingSection({ title, description, icon, children }: { title: string; description: string; icon: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHeader}><i>{icon}</i><span><strong>{title}</strong><small>{description}</small></span></div>
      {children}
    </section>
  );
}

function ChoiceCard({ selected, title, description, onClick }: { selected: boolean; title: string; description: string; onClick: () => void }) {
  return <button type="button" aria-pressed={selected} className={`${styles.choice} ${selected ? styles.selected : ""}`} onClick={onClick}><span><strong>{title}</strong><small>{description}</small></span>{selected ? <IconTick /> : null}</button>;
}

function ThemeCard({ value, current, icon, title, description, onChange }: { value: ThemePreference; current: ThemePreference; icon: ReactNode; title: string; description: string; onChange: (value: ThemePreference) => void }) {
  const selected = value === current;
  return <button type="button" aria-pressed={selected} className={`${styles.themeChoice} ${selected ? styles.selected : ""}`} onClick={() => onChange(value)}><i>{icon}</i><span><strong>{title}</strong><small>{description}</small></span>{selected ? <b><IconTick /></b> : null}</button>;
}

