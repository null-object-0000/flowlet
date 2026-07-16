import { useState } from "react";
import { Button, Modal, Select } from "@douyinfe/semi-ui-19";
import { IconDelete } from "@douyinfe/semi-icons";
import styles from "./ClearRequestLogsModal.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

const OPTIONS = [
  { value: 0, label: "清除全部日志" },
  { value: 7, label: "保留最近 7 天" },
  { value: 30, label: "保留最近 30 天" },
  { value: 90, label: "保留最近 90 天" },
];

export function ClearRequestLogsModal({ total, loading, onCancel, onConfirm }: { total: number; loading: boolean; onCancel: () => void; onConfirm: (keepDays: number) => void }) {
  const { t } = useAppPreferences();
  const [keepDays, setKeepDays] = useState(30);
  const [confirming, setConfirming] = useState(false);
  const label = t(OPTIONS.find((item) => item.value === keepDays)?.label ?? "清除全部日志");

  return (
    <Modal
      visible
      motion={false}
      width={460}
      title={t(confirming ? "再次确认清理范围" : "清理请求日志")}
      footer={(
        <div className={styles.footer}>
          <Button onClick={confirming ? () => setConfirming(false) : onCancel}>{t(confirming ? "返回" : "取消")}</Button>
          <Button icon={<IconDelete />} type="danger" theme="solid" loading={loading} onClick={() => confirming ? onConfirm(keepDays) : setConfirming(true)}>{t(confirming ? "永久清除" : "继续")}</Button>
        </div>
      )}
      onCancel={onCancel}
    >
      <div className={styles.body}>
        {confirming ? (
          <><p>{t("即将执行：{scope}。对应的请求日志和用量记录会被永久删除。", { scope: label })}</p><div className={styles.danger}>{t("此操作不可恢复，请确认清理范围无误。")}</div></>
        ) : (
          <><p>{t("当前查询共 {total} 条。请选择整个数据库中的日志保留范围：", { total })}</p><Select value={keepDays} optionList={OPTIONS.map((option) => ({ ...option, label: t(option.label) }))} onChange={(value) => setKeepDays(Number(value))} style={{ width: "100%" }} /><span>{t("清理会同步删除对应的用量记录，但不会影响账号、模型或代理配置。")}</span></>
        )}
      </div>
    </Modal>
  );
}
