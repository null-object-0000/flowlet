import { Switch, Typography } from "@douyinfe/semi-ui-19";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { ChannelBrandLogo } from "../channel-accounts/ChannelBrandLogo";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { buildOverviewExposedModels } from "./modelView";
import styles from "./OverviewExposedModelsCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Text } = Typography;

type Props = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  busyModelId?: string;
  onManage: () => void;
  onToggle: (routeIds: string[], modelId: string, enabled: boolean) => void;
};

export function OverviewExposedModelsCard({ routes, accounts, channels, busyModelId, onManage, onToggle }: Props) {
  const { t } = useAppPreferences();
  const models = buildOverviewExposedModels(routes, accounts, channels);
  const enabledCount = models.filter((model) => model.enabled).length;
  const totalCount = models.length;

  return (
    <OverviewModuleCard title={<span className={styles.cardTitle}>{t("开放模型")} <em>{t("已启用 {enabled} / 共 {total} 个模型", { enabled: enabledCount, total: totalCount })}</em></span>} action={t("管理模型")} onAction={onManage}>
      {models.length > 0 ? (
        <div className={styles.list}>
          {models.map((model) => {
            const abnormal = model.enabled && !model.hasAvailableAccount;
            return (
              <div className={styles.row} key={model.publicModel}>
                <ChannelBrandLogo
                  channelId={model.channelId ?? "flowlet"}
                  name={model.channelName ?? "Flowlet"}
                />
                <div className={styles.main}>
                  <Text strong>{model.publicModel}</Text>
                  <Text className={abnormal ? styles.warning : styles.meta} size="small">
                    {model.availableAccountCount > 0 ? t("{count} 个可用账号", { count: model.availableAccountCount }) : t("无可用账号")}
                    {abnormal ? ` · ${t("异常")}` : !model.hasAvailableAccount ? ` · ${t("不可用")}` : ""}
                  </Text>
                </div>
                <Switch
                  aria-label={t("{model} 对外开放", { model: model.publicModel })}
                  checked={model.enabled}
                  disabled={busyModelId != null}
                  loading={busyModelId === model.publicModel}
                  onChange={(checked) => onToggle(model.routeIds, model.publicModel, checked)}
                />
              </div>
            );
          })}
        </div>
      ) : (
        <div className={styles.empty}>{t("暂无模型。请同步或进入模型服务生成默认模型。")}</div>
      )}
    </OverviewModuleCard>
  );
}
