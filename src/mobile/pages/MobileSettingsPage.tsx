import { Button, Input, Switch, Toast } from "@douyinfe/semi-ui-19";
import { useEffect, useState } from "react";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import type { S3SyncConfigInput } from "../../domains/device-sync/types";
import { useMobileDeviceSyncActions, useMobileS3Settings } from "../../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../../shared/errors/AppError";
import styles from "./MobilePage.module.css";

const emptyConfig: S3SyncConfigInput = {
  endpoint: "",
  region: "auto",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: null,
  pathStyle: false,
};

export function MobileSettingsPage() {
  const { t } = useAppPreferences();
  const settings = useMobileS3Settings();
  const actions = useMobileDeviceSyncActions();
  const [draft, setDraft] = useState<S3SyncConfigInput>(emptyConfig);

  useEffect(() => {
    if (!settings.data?.config) return;
    setDraft({ ...settings.data.config, secretAccessKey: null });
  }, [settings.data?.config]);

  const valid = draft.endpoint.trim() && draft.region.trim() && draft.bucket.trim() && draft.accessKeyId.trim();
  const save = async () => {
    try {
      await actions.saveS3Config.mutateAsync(draft);
      Toast.success(t("S3 查看配置已保存"));
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: errorMessage(error) }));
    }
  };
  const test = async () => {
    try {
      const result = await actions.testS3Connection.mutateAsync(draft);
      Toast.success(result.message);
    } catch (error) {
      Toast.error(t("连接测试失败：{message}", { message: errorMessage(error) }));
    }
  };

  return (
    <section className={styles.page}>
      <header className={styles.heading}><div><h2>{t("设置")}</h2><p>{t("配置只读 S3 数据源，凭据不会进入同步快照")}</p></div></header>
      <article className={styles.card}>
        <div className={styles.cardHeader}><div><strong>{t("S3-compatible 数据源")}</strong><span>{t("与桌面端使用相同的 Bucket 和路径前缀")}</span></div></div>
        <div className={styles.form}>
          <label>Endpoint<Input value={draft.endpoint} placeholder="https://s3.example.com" onChange={(endpoint) => setDraft({ ...draft, endpoint })} /></label>
          <div className={styles.formGrid}>
            <label>Region<Input value={draft.region} placeholder="auto" onChange={(region) => setDraft({ ...draft, region })} /></label>
            <label>Bucket<Input value={draft.bucket} placeholder="flowlet-sync" onChange={(bucket) => setDraft({ ...draft, bucket })} /></label>
          </div>
          <label>{t("路径前缀（可选）")}<Input value={draft.prefix} placeholder="users/me" onChange={(prefix) => setDraft({ ...draft, prefix })} /></label>
          <label>Access Key ID<Input value={draft.accessKeyId} onChange={(accessKeyId) => setDraft({ ...draft, accessKeyId })} /></label>
          <label>Secret Access Key<Input mode="password" value={draft.secretAccessKey} placeholder={settings.data?.config?.secretConfigured ? t("已安全保存，留空则保持不变") : t("请输入 Secret Access Key")} onChange={(secretAccessKey) => setDraft({ ...draft, secretAccessKey })} /></label>
          <div className={styles.switchRow}>
            <div><strong>{t("使用 Path-style 地址")}</strong><span>{t("MinIO 和部分兼容服务需要开启；阿里云 OSS 关闭")}</span></div>
            <Switch checked={draft.pathStyle} aria-label={t("使用 Path-style 地址")} onChange={(pathStyle) => setDraft({ ...draft, pathStyle })} />
          </div>
          <div className={styles.permissions}><strong>{t("移动端只读权限")}</strong><span>Bucket：HeadBucket / ListObjects；Object：GetObject</span></div>
          <div className={styles.actions}>
            <Button loading={actions.testS3Connection.isPending} disabled={!valid} onClick={() => void test()}>{t("测试只读连接")}</Button>
            <Button theme="solid" type="primary" loading={actions.saveS3Config.isPending} disabled={!valid} onClick={() => void save()}>{t("保存配置")}</Button>
          </div>
        </div>
      </article>
    </section>
  );
}
