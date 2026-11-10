import { useEffect, useState } from "react";
import { Input, InputNumber, Select, Switch, Toast } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UsageCostDisplayConfig } from "../../domains/settings/types";
import { useUsageCostDisplaySetting } from "../../features/settings/useUsageCostDisplaySetting";
import { SettingRow, SettingSection } from "./SettingRow";
import styles from "./UsageCostDisplaySettings.module.css";

import { errorMessage } from "../../shared/errors/AppError";
/**
 * 「费用展示」设置区块：统一货币折算、展示币种、固定汇率与汇率备注。
 * 桌面端设置页与 Web（Docker）设置页共用；配置读写分别走 config.json
 * 与 SQLite app_meta，由 domain settings command 按运行平台分流。
 */
export function UsageCostDisplaySettings() {
  const { t } = useAppPreferences();
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
      const message = errorMessage(error);
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
  );
}
