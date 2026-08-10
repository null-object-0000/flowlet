import { Tag, Typography } from "@douyinfe/semi-ui-19";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { ChannelBrandLogo } from "../channel-accounts/ChannelBrandLogo";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { buildOverviewAggregateModels, type OverviewAggregateModel } from "./modelView";
import styles from "./OverviewExposedModelsCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Text } = Typography;

type Props = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  onManage: () => void;
};

export function OverviewExposedModelsCard({ routes, accounts, channels, onManage }: Props) {
  const { t } = useAppPreferences();
  const models = buildOverviewAggregateModels(routes, accounts, channels);

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>{t("聚合模型")} <em>{t("共 {count} 个聚合模型", { count: models.length })}</em></span>}
      action={t("管理模型")}
      onAction={onManage}
    >
      {accounts.length > 0 ? <div className={styles.list}>
        {models.map((model) => {
          const status = aggregateStatus(model);
          return (
            <div className={styles.row} key={model.publicModel}>
              <ChannelBrandLogo channelId="flowlet" name="Flowlet" />
              <div className={styles.main}>
                <div className={styles.nameLine}>
                  <Text strong>{model.publicModel}</Text>
                  <Text className={styles.tier} size="small">
                    {t(model.publicModel === "flowlet-pro" ? "能力优先" : "速度优先")}
                  </Text>
                </div>
                <div className={styles.metaLine}>
                  <span>{model.candidateModelCount > 0
                    ? t("{availableModels} / {totalModels} 个模型可用 · {availableAccounts} / {totalAccounts} 个账号可用", {
                        availableModels: model.availableModelCount,
                        totalModels: model.candidateModelCount,
                        availableAccounts: model.availableAccountCount,
                        totalAccounts: model.candidateAccountCount,
                      })
                    : t("尚无候选模型")}</span>
                </div>
              </div>
              <Tag color={status.color}>{t(status.label)}</Tag>
            </div>
          );
        })}
      </div> : (
        <div className={styles.empty}>
          {t("添加渠道账号并配置聚合路由后，这里会显示可用状态。")}
        </div>
      )}
    </OverviewModuleCard>
  );
}

function aggregateStatus(model: OverviewAggregateModel): { label: string; color: "green" | "orange" | "grey" } {
  if (model.availableAccountCount === 0) return { label: "不可用", color: "grey" };
  if (model.availableAccountCount < model.candidateAccountCount) return { label: "部分可用", color: "orange" };
  return { label: "可用", color: "green" };
}
