import { useEffect, useState } from "react";
import { Input, Switch, Toast } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { UpstreamProxyConfig } from "../../domains/settings/types";
import { useUpstreamProxySetting } from "../../features/settings/useUpstreamProxySetting";
import { SettingRow, SettingSection } from "./SettingRow";
import styles from "./UsageCostDisplaySettings.module.css";

import { errorMessage } from "../../shared/errors/AppError";
export function UpstreamProxySettings() {
  const { t } = useAppPreferences();
  const upstreamProxy = useUpstreamProxySetting();
  const [proxyUrlDraft, setProxyUrlDraft] = useState("");

  useEffect(() => {
    if (!upstreamProxy.query.data) return;
    setProxyUrlDraft(upstreamProxy.query.data.url);
  }, [upstreamProxy.query.data]);

  const saveUpstreamProxy = async (patch: Partial<UpstreamProxyConfig>) => {
    const current = upstreamProxy.query.data;
    if (!current) return;
    try {
      await upstreamProxy.mutation.mutateAsync({ ...current, ...patch });
      Toast.success(t("设置已自动保存"));
    } catch (error) {
      const message = errorMessage(error);
      Toast.error(t("保存失败：{message}", { message }));
    }
  };

  const saveProxyUrlDraft = () => {
    const url = proxyUrlDraft.trim();
    const currentUrl = upstreamProxy.query.data?.url ?? "";
    if (url === currentUrl) return;
    if (url && !/^https?:\/\/.+/.test(url)) {
      setProxyUrlDraft(currentUrl);
      Toast.error(t("代理地址需以 http:// 或 https:// 开头"));
      return;
    }
    void saveUpstreamProxy({ url });
  };

  return (
    <SettingSection
      title={t("网络")}
      note={t("新账号默认直连，可在账号高级设置中选择使用这里配置的代理。")}
      keywords="网络 代理 上游代理 proxy 直连"
    >
      <SettingRow
        name={t("全局请求使用代理")}
        help={t("用于版本检查等全局请求。渠道账号的网络出口单独设置。")}
        control={(
          <Switch
            aria-label={t("全局请求使用代理")}
            checked={upstreamProxy.query.data?.enabled ?? false}
            loading={upstreamProxy.query.isLoading || upstreamProxy.mutation.isPending}
            disabled={upstreamProxy.query.isError}
            onChange={(checked) => {
              const url = upstreamProxy.query.data?.url ?? "";
              if (checked && !url) {
                Toast.error(t("请先填写代理地址"));
                return;
              }
              void saveUpstreamProxy({ enabled: checked });
            }}
          />
        )}
      />
      <SettingRow
        name={t("代理地址")}
        help={t("仅支持 http/https，例如 http://127.0.0.1:7890")}
        control={(
          <Input
            aria-label={t("代理地址")}
            className={styles.noteInput}
            value={proxyUrlDraft}
            placeholder="http://127.0.0.1:7890"
            disabled={upstreamProxy.query.isLoading || upstreamProxy.mutation.isPending}
            onChange={setProxyUrlDraft}
            onBlur={saveProxyUrlDraft}
            onEnterPress={saveProxyUrlDraft}
          />
        )}
      />
    </SettingSection>
  );
}
