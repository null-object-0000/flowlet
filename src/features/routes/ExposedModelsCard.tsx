import React from "react";
import { Button, Switch, Text, Tooltip } from "@mantine/core";
import { IconChevronRight } from "@tabler/icons-react";
import { ExposedModel } from "./exposedModels";
import { RouteCandidate } from "../../domain";
import { ChannelLogo } from "../../components/ChannelLogo";
import { Panel, PanelHeader } from "../../components/ui";
import styles from "./ExposedModelsCard.module.css";

type ExposedModelsCardProps = {
  exposedModels: ExposedModel[];
  onOpenModelServices: () => void;
  onUpdateRoute: (index: number, patch: Partial<RouteCandidate>) => void;
  onSaveRoutes: () => void;
};

export function ExposedModelsCard({
  exposedModels,
  onOpenModelServices,
  onUpdateRoute,
  onSaveRoutes,
}: ExposedModelsCardProps) {
  function setModelEnabled(routeIndexes: number[], enabled: boolean) {
    routeIndexes.forEach((routeIndex) => onUpdateRoute(routeIndex, { enabled }));
    window.setTimeout(() => void onSaveRoutes(), 0);
  }

  return (
    <Panel className="overview-section-card overview-section-card--grow">
      <PanelHeader>
        <div>
          <h3>开放模型　已开放 {exposedModels.filter((model) => model.enabled).length} 个模型</h3>
        </div>
        <Button className="overview-view-all" variant="subtle" rightSection={<IconChevronRight size={15} />} onClick={onOpenModelServices}>查看全部</Button>
      </PanelHeader>
      <div className="overview-list">
        {exposedModels.length === 0 ? <Text c="dimmed">暂无模型。请同步或进入模型服务生成默认模型。</Text> : null}
        {exposedModels.map((model) => {
          const abnormal = model.enabled && !model.hasAvailableAccount;
          return (
            <div className={styles.row} key={model.publicModel}>
              <Tooltip label={model.channelName ?? ""} withArrow position="top">
                <ChannelLogo channelId={model.channelId ?? ""} channelName={model.channelName ?? ""} size={32} variant="avatar" />
              </Tooltip>
              <div className="row-main">
                <strong>{model.publicModel}</strong>
                <span className={abnormal ? styles.meta + " " + styles.warn : styles.meta}>
                  {model.availableAccountCount > 0 ? `${model.availableAccountCount} 个可用账号` : "无可用账号"}
                </span>
                {abnormal || !model.hasAvailableAccount ? (
                  <span className={abnormal ? styles.meta + " " + styles.warn : styles.meta}>
                    {abnormal ? "异常" : "不可用"}
                  </span>
                ) : null}
              </div>
              <Switch checked={model.enabled} onChange={(event) => setModelEnabled(model.routeIndexes, event.currentTarget.checked)} />
            </div>
          );
        })}
      </div>
    </Panel>
  );
}
