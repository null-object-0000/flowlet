import { Tag, Typography } from "@douyinfe/semi-ui-19";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { ChannelBrandLogo } from "../channel-accounts/ChannelBrandLogo";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { OverviewListRowView, OverviewListView } from "@flowlet/product-ui";
import { buildOverviewAggregateModels, type OverviewAggregateModel } from "./modelView";
import styles from "./OverviewExposedModelsCard.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const { Text } = Typography;

type Props = {
  routes: RouteCandidate[];
  accounts: ChannelAccount[];
  channels: ChannelPreset[];
  onManage: () => void;
  onOpenModel: (publicModel: string) => void;
};

export function OverviewExposedModelsCard({ routes, accounts, channels, onManage, onOpenModel }: Props) {
  const { t } = useAppPreferences();
  const models = buildOverviewAggregateModels(routes, accounts, channels);

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>{t("聚合模型")} <em>{t("共 {count} 个聚合模型", { count: models.length })}</em></span>}
      action={t("管理模型")}
      onAction={onManage}
    >
      {accounts.length > 0 ? <OverviewListView>
        {models.map((model) => {
          const status = aggregateStatus(model);
          return (
            <OverviewListRowView
              key={model.publicModel}
              logo={<ChannelBrandLogo channelId="flowlet" name="Flowlet" />}
              title={<span className={styles.nameLine}>
                  <Text strong>{model.publicModel}</Text>
                  <Text className={styles.tier} size="small">
                    {t(model.publicModel === "flowlet-pro" ? "能力优先" : "速度优先")}
                  </Text>
                </span>}
              subtitle={<span className={styles.metaLine}>{model.candidateModelCount > 0
                    ? t("{availableModels} / {totalModels} 个模型可用 · {availableAccounts} / {totalAccounts} 个账号可用", {
                        availableModels: model.availableModelCount,
                        totalModels: model.candidateModelCount,
                        availableAccounts: model.availableAccountCount,
                        totalAccounts: model.candidateAccountCount,
                      })
                    : t("尚无候选模型")}</span>}
              trailing={<Tag color={status.color}>{t(status.label)}</Tag>}
              onClick={() => onOpenModel(model.publicModel)}
              ariaLabel={t("查看 {model} 模型详情", { model: model.publicModel })}
            />
          );
        })}
      </OverviewListView> : (
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
