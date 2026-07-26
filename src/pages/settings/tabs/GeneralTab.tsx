import { Select, Switch } from "@douyinfe/semi-ui-19";
import type { AppLanguage } from "../../../app/preferences/translations";
import { useAppPreferences, type ThemePreference } from "../../../app/preferences/AppPreferences";
import { useAutostartSetting } from "../../../features/settings/useAutostartSetting";
import { SettingRow, SettingSection } from "../SettingRow";

export function GeneralTab() {
  const { language, setLanguage, theme, setTheme, t } = useAppPreferences();
  const autostart = useAutostartSetting();

  return (
    <div>
      <SettingSection title={t("外观")} keywords="外观 显示语言 简体中文 主题 跟随系统 深色 浅色">
        <SettingRow
          name={t("显示语言")}
          help={t("选择应用界面的显示语言")}
          control={(
            <Select
              value={language}
              optionList={[
                { value: "zh-CN", label: t("简体中文") },
                { value: "en-US", label: "English" },
              ]}
              onChange={(value) => setLanguage(value as AppLanguage)}
            />
          )}
        />
        <SettingRow
          name={t("界面主题")}
          help={t("跟随系统，或固定使用浅色 / 深色主题")}
          control={(
            <Select
              value={theme}
              optionList={[
                { value: "system", label: t("跟随系统") },
                { value: "light", label: t("浅色模式") },
                { value: "dark", label: t("深色模式") },
              ]}
              onChange={(value) => setTheme(value as ThemePreference)}
            />
          )}
        />
      </SettingSection>

      <SettingSection title={t("启动与运行")} keywords="启动 登录后自动启动 关闭 后台运行">
        <SettingRow
          name={t("登录后自动启动 Flowlet")}
          help={t("登录系统后在后台启动应用")}
          control={(
            <Switch
              aria-label={t("开机启动")}
              checked={autostart.query.data ?? false}
              loading={autostart.query.isLoading || autostart.mutation.isPending}
              disabled={autostart.query.isError}
              onChange={(checked) => {
                void autostart.mutation.mutateAsync(checked);
              }}
            />
          )}
        />
        <SettingRow
          name={t("关闭窗口后继续运行")}
          help={t("点击关闭按钮时最小化到托盘，不中断本地代理服务")}
          control={<Switch aria-label={t("关闭窗口后继续运行")} defaultChecked />}
        />
      </SettingSection>

      <SettingSection title={t("通知")} keywords="通知 系统通知 错误 完成">
        <SettingRow
          name={t("系统通知")}
          help={t("在同步失败、修复完成等重要状态变化时发送通知")}
          control={<Switch aria-label={t("系统通知")} />}
        />
      </SettingSection>
    </div>
  );
}
