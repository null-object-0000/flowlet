import { Tag, Typography } from "@douyinfe/semi-ui-19";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import type { RouteCandidate } from "../../domains/model/types";
import { ChannelBrandLogo } from "../channel-accounts/ChannelBrandLogo";
import { OverviewModuleCard } from "../../shared/ui/OverviewModuleCard";
import { OverviewListRowView, OverviewListView } from "@flowlet/product-ui";
import { buildOverviewExposedModels, type OverviewExposedModel } from "./modelView";
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
  const models = buildOverviewExposedModels(routes, accounts, channels);

  return (
    <OverviewModuleCard
      title={<span className={styles.cardTitle}>{t("开放模型")} <em>{t("共 {count} 个模型", { count: models.length })}</em></span>}
      action={t("管理模型")}
      onAction={onManage}
    >
      {models.length > 0 ? <OverviewListView>
        {models.map((model) => {
          const status = exposedModelStatus(model);
          return (
            <OverviewListRowView
              key={model.publicModel}
              logo={<ChannelBrandLogo channelId={model.channelId ?? "flowlet"} name={model.channelName ?? model.publicModel} />}
              title={<span className={styles.nameLine}>
                  <Text strong>{model.publicModel}</Text>
                  {model.channelName ? <Text className={styles.tier} size="small">{model.channelName}</Text> : null}
                </span>}
              subtitle={<span className={styles.metaLine}>{t("{availableModels} / {totalModels} 个模型可用 · {availableAccounts} / {totalAccounts} 个账号可用", {
                availableModels: model.availableModelCount,
                totalModels: model.candidateModelCount,
                availableAccounts: model.availableAccountCount,
                totalAccounts: model.candidateAccountCount,
              })}</span>}
              trailing={<Tag color={status.color}>{t(status.label)}</Tag>}
              onClick={() => onOpenModel(model.publicModel)}
              ariaLabel={t("查看 {model} 模型详情", { model: model.publicModel })}
            />
          );
        })}
      </OverviewListView> : (
        <div className={styles.empty}>
          {t("添加渠道账号并选择开放模型后，这里会显示模型。")}
        </div>
      )}
    </OverviewModuleCard>
  );
}

function exposedModelStatus(model: OverviewExposedModel): { label: string; color: "green" | "orange" | "grey" } {
  if (model.availableAccountCount === 0) return { label: "不可用", color: "grey" };
  if (model.availableAccountCount < model.candidateAccountCount) return { label: "部分可用", color: "orange" };
  return { label: "可用", color: "green" };
}
