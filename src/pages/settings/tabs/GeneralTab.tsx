import { useEffect, useState } from "react";
import { Input, InputNumber, Select, Switch, Toast } from "@douyinfe/semi-ui-19";
import type { AppLanguage } from "../../../app/preferences/translations";
import { useAppPreferences, type ThemePreference } from "../../../app/preferences/AppPreferences";
import type { TokenUnit } from "../../../shared/formatters/number";
import { useAutostartSetting } from "../../../features/settings/useAutostartSetting";
import { useTaskReviewNotification } from "../../../features/settings/useTaskReviewNotification";
import { useUsageCostDisplaySetting } from "../../../features/settings/useUsageCostDisplaySetting";
import type { UsageCostDisplayConfig } from "../../../domains/settings/types";
import { SettingRow, SettingSection } from "../SettingRow";
import styles from "./GeneralTab.module.css";

export function GeneralTab() {
  const { language, setLanguage, theme, setTheme, tokenUnit, setTokenUnit, t } = useAppPreferences();
  const autostart = useAutostartSetting();
  const taskReviewNotification = useTaskReviewNotification();
  const usageCost = useUsageCostDisplaySetting();
  const [rateDraft, setRateDraft] = useState<number | string>(7.2);
  const [noteDraft, setNoteDraft] = useState("");

  useEffect(() => {
    if (!usageCost.query.data) return;
    setRateDraft(usageCost.query.data.usd_to_cny_rate);
    setNoteDraft(usageCost.query.data.exchange_rate_note);
  }, [usageCost.query.data]);

  const saveUsageCost = async (patch: Partial<UsageCostDisplayConfig>) => {
    const current = usageCost.query.data;
    if (!current) return;
    try {
      await usageCost.mutation.mutateAsync({ ...current, ...patch });
      Toast.success(t("设置已自动保存"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Toast.error(t("保存失败：{message}", { message }));
    }
  };

  const saveRateDraft = () => {
    const rate = typeof rateDraft === "number" ? rateDraft : Number(rateDraft);
    if (!Number.isFinite(rate) || rate <= 0) {
      setRateDraft(usageCost.query.data?.usd_to_cny_rate ?? 7.2);
      Toast.error(t("汇率必须是大于 0 的数字"));
      return;
    }
    if (rate === usageCost.query.data?.usd_to_cny_rate) return;
    void saveUsageCost({ usd_to_cny_rate: rate });
  };

  return (
    <div>
      <SettingSection title={t("外观")} keywords="外观 显示语言 简体中文 主题 跟随系统 深色 浅色 Token 展示单位 万 亿 K M">
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
        <SettingRow
          name={t("Token 展示单位")}
          help={t("选择 Token 数量以哪种单位展示；默认跟随界面语言，简体中文用「万 / 亿」，英文用「K / M」")}
          control={(
            <Select
              value={tokenUnit}
              optionList={[
                { value: "auto", label: t("跟随语言") },
                { value: "zh", label: t("万 / 亿（中文习惯）") },
                { value: "en", label: t("K / M（英文习惯）") },
              ]}
              onChange={(value) => setTokenUnit(value as TokenUnit)}
            />
          )}
        />
      </SettingSection>

      <SettingSection
        title={t("费用展示")}
        note={t("固定汇率只用于费用汇总展示；原始币种金额始终保留，不作为真实结算汇率。")}
        keywords="费用 汇率 美元 人民币 USD CNY 折算 API 等价价值"
      >
        <SettingRow
          name={t("启用统一货币折算")}
          help={t("启用后，用量页可按这里维护的固定汇率展示折算总额")}
          control={(
            <Switch
              aria-label={t("启用统一货币折算")}
              checked={usageCost.query.data?.currency_conversion_enabled ?? false}
              loading={usageCost.query.isLoading || usageCost.mutation.isPending}
              disabled={usageCost.query.isError}
              onChange={(checked) => void saveUsageCost({ currency_conversion_enabled: checked })}
            />
          )}
        />
        <SettingRow
          name={t("统一展示币种")}
          help={t("汇总卡片和费用图表的目标展示币种")}
          control={(
            <Select
              aria-label={t("统一展示币种")}
              className={styles.currencySelect}
              value={usageCost.query.data?.display_currency ?? "CNY"}
              disabled={usageCost.query.isLoading || usageCost.mutation.isPending}
              optionList={[
                { value: "CNY", label: "CNY（¥）" },
                { value: "USD", label: "USD（$）" },
              ]}
              onChange={(value) => void saveUsageCost({ display_currency: value as "CNY" | "USD" })}
            />
          )}
        />
        <SettingRow
          name={t("USD → CNY 固定汇率")}
          help={t("表示 1 USD 可折算为多少 CNY；切换目标币种时会使用其倒数")}
          control={(
            <InputNumber
              aria-label={t("USD → CNY 固定汇率")}
              className={styles.rateInput}
              value={rateDraft}
              min={0.000001}
              max={1000000}
              precision={6}
              step={0.01}
              hideButtons
              disabled={usageCost.query.isLoading || usageCost.mutation.isPending}
              suffix="CNY"
              onChange={setRateDraft}
              onBlur={saveRateDraft}
              onEnterPress={saveRateDraft}
            />
          )}
        />
        <SettingRow
          name={t("汇率备注")}
          help={t("可记录汇率来源或维护日期，便于之后核对展示口径")}
          control={(
            <Input
              aria-label={t("汇率备注")}
              className={styles.noteInput}
              value={noteDraft}
              maxLength={120}
              placeholder={t("例如：手工设置，2026-08-13")}
              disabled={usageCost.query.isLoading || usageCost.mutation.isPending}
              onChange={setNoteDraft}
              onBlur={() => {
                const note = noteDraft.trim();
                if (note === usageCost.query.data?.exchange_rate_note) return;
                void saveUsageCost({ exchange_rate_note: note });
              }}
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

      <SettingSection title={t("通知")} keywords="通知 系统通知 任务 待审核 完成">
        <SettingRow
          name={t("任务完成待审核通知")}
          help={t("任务执行完成进入待审核时发送系统通知")}
          control={(
            <Switch
              aria-label={t("任务完成待审核通知")}
              checked={taskReviewNotification.query.data ?? true}
              loading={
                taskReviewNotification.query.isLoading ||
                taskReviewNotification.mutation.isPending
              }
              disabled={taskReviewNotification.query.isError}
              onChange={(checked) => {
                void taskReviewNotification.mutation.mutateAsync(checked);
              }}
            />
          )}
        />
      </SettingSection>
    </div>
  );
}
