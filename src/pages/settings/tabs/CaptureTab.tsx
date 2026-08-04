import { Select, Switch, Toast } from "@douyinfe/semi-ui-19";
import { useLogCaptureSetting } from "../../../features/settings/useLogCaptureSetting";
import { SettingRow, SettingSection, SettingBadge } from "../SettingRow";
import styles from "./CaptureTab.module.css";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";

export function CaptureTab() {
  const { t } = useAppPreferences();
  const logCapture = useLogCaptureSetting();
  const data = logCapture.query.data;

  const update = async (key: string, value: boolean | number) => {
    if (!data) return;
    const updated = { ...data, [key]: value } as Parameters<typeof logCapture.mutation.mutateAsync>[0];
    try {
      await logCapture.mutation.mutateAsync(updated);
      Toast.success(t("设置已自动保存"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      Toast.error(t("保存失败：{message}", { message }));
    }
  };

  const bodyToggleOn = data ? (data.capture_req_body || data.capture_res_body) : true;

  return (
    <div>
      <SettingSection title={t("请求与响应内容")} note={t("关闭 Body 捕获可以显著降低本地存储占用。")} keywords="请求 响应 Body 日志 捕获 Token">
        <SettingRow
          name={t("记录请求 Body")}
          help={t("用于查看完整请求内容，可能包含较多 Token")}
          control={(
            <Switch
              aria-label={t("记录请求 Body")}
              checked={data?.capture_req_body ?? true}
              loading={logCapture.query.isLoading || logCapture.mutation.isPending}
              onChange={(checked) => void update("capture_req_body", checked)}
            />
          )}
        />
        <SettingRow
          name={t("记录响应 Body")}
          help={t("用于查看完整响应和修复 Token 用量")}
          control={(
            <Switch
              aria-label={t("记录响应 Body")}
              checked={data?.capture_res_body ?? true}
              loading={logCapture.query.isLoading || logCapture.mutation.isPending}
              onChange={(checked) => void update("capture_res_body", checked)}
            />
          )}
        />
      </SettingSection>

      <div className={`${styles.policySection} ${bodyToggleOn ? "" : styles.policyDisabled}`}>
        <SettingSection title={t("存储策略")} keywords="保留天数 存储上限 自动清理">
          <SettingRow
            name={t("Body 保留时长")}
            help={t("超过保留时间后自动清理，统计汇总不会受影响")}
            control={(
              <Select
                value={data?.body_retention_days ?? 7}
                optionList={[
                  { value: 1, label: t("1 天") },
                  { value: 3, label: t("3 天") },
                  { value: 7, label: t("7 天") },
                  { value: 30, label: t("30 天") },
                  { value: -1, label: t("永久保留") },
                ]}
                onChange={(value) => void update("body_retention_days", value as number)}
              />
            )}
          />
          <SettingRow
            name={t("Body 存储上限")}
            help={t("达到上限后优先清理较早的数据")}
            control={(
              <Select
                value={data?.body_max_size_mb ?? 1024}
                className={styles.smallSelect}
                optionList={[
                  { value: 128, label: "128 MB" },
                  { value: 512, label: "512 MB" },
                  { value: 1024, label: "1 GB" },
                  { value: 5120, label: "5 GB" },
                  { value: 0, label: t("不限制") },
                ]}
                onChange={(value) => void update("body_max_size_mb", value as number)}
              />
            )}
          />
        </SettingSection>
      </div>

      <SettingSection title={t("隐私保护")} keywords="隐私 脱敏 Header Authorization X-API-Key Cookie">
        <SettingRow
          name={t("自动脱敏敏感 Header")}
          help={t("将 Authorization、X-API-Key、Cookie 等敏感字段替换为 [redacted]")}
          control={(
            <>
              <SettingBadge>{t("推荐开启")}</SettingBadge>
              <Switch
                aria-label={t("自动脱敏敏感 Header")}
                checked={data?.redact_sensitive_headers ?? false}
                loading={logCapture.query.isLoading || logCapture.mutation.isPending}
                onChange={(checked) => void update("redact_sensitive_headers", checked)}
              />
            </>
          )}
        />
      </SettingSection>
    </div>
  );
}
