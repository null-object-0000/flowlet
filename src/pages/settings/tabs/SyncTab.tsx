import { IconCopy, IconQrCode } from "@douyinfe/semi-icons";
import { Button, Input, Modal, SideSheet, Switch, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";
import {
  parseS3ConnectionPackage,
  serializeS3ConnectionPackage,
} from "../../../domains/device-sync/s3ConnectionPackage";
import type {
  DeviceUsageImportPreview,
  S3SyncConfigInput,
} from "../../../domains/device-sync/types";
import {
  useDeviceUsageTransfer,
  useKnownDevices,
  useS3SyncSettings,
} from "../../../features/device-sync/useDeviceSync";
import { errorMessage } from "../../../shared/errors/AppError";
import { formatCompactNumber } from "../../../shared/formatters/number";
import { APP_OVERLAY_Z_INDEX } from "../../../shared/ui/overlayLayers";
import styles from "./SyncTab.module.css";

type S3Draft = Omit<S3SyncConfigInput, "secretAccessKey"> & { secretAccessKey: string };

const EMPTY_S3_DRAFT: S3Draft = {
  endpoint: "",
  region: "auto",
  bucket: "",
  prefix: "",
  accessKeyId: "",
  secretAccessKey: "",
  pathStyle: true,
};

export function SyncTab() {
  const { language, t } = useAppPreferences();
  const devices = useKnownDevices();
  const settings = useS3SyncSettings();
  const transfer = useDeviceUsageTransfer();
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeviceUsageImportPreview | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [s3Draft, setS3Draft] = useState<S3Draft | null>(null);
  const [sharePackage, setSharePackage] = useState<{ text: string; qr: string } | null>(null);
  const [connectionText, setConnectionText] = useState<string | null>(null);

  const parsedConnection = useMemo(() => {
    if (connectionText == null || !connectionText.trim()) return null;
    try {
      return { config: parseS3ConnectionPackage(connectionText), error: null };
    } catch (error) {
      return { config: null, error: errorMessage(error) };
    }
  }, [connectionText]);

  useEffect(() => {
    if (!sharePackage) return undefined;
    const timer = window.setTimeout(() => setSharePackage(null), 60_000);
    return () => window.clearTimeout(timer);
  }, [sharePackage]);

  const exportUsage = async () => {
    const path = await save({
      defaultPath: `flowlet-usage-${new Date().toISOString().slice(0, 10)}.flowlet.json`,
        filters: [{ name: t("Flowlet 设备用量"), extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await transfer.exportBundle.mutateAsync(path);
      Toast.success(t("设备用量已导出"));
    } catch (error) {
      Toast.error(t("导出失败：{message}", { message: errorMessage(error) }));
    }
  };

  const chooseUsageImport = async () => {
    const path = await open({
      multiple: false,
      directory: false,
        filters: [{ name: t("Flowlet 设备用量"), extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const result = await transfer.previewImport.mutateAsync(path);
      setImportPath(path);
      setPreview(result);
    } catch (error) {
      Toast.error(t("读取导入文件失败：{message}", { message: errorMessage(error) }));
    }
  };

  const applyUsageImport = async () => {
    if (!importPath || !preview) return;
    try {
      const result = await transfer.importBundle.mutateAsync(importPath);
      Toast.success(t("已导入 {count} 天设备用量", { count: result.importedDays }));
      setImportPath(null);
      setPreview(null);
    } catch (error) {
      Toast.error(t("导入失败：{message}", { message: errorMessage(error) }));
    }
  };

  const applyRename = async () => {
    if (renameValue == null) return;
    try {
      await transfer.renameCurrentDevice.mutateAsync(renameValue.trim());
      Toast.success(t("设备名称已更新"));
      setRenameValue(null);
    } catch (error) {
      Toast.error(t("重命名失败：{message}", { message: errorMessage(error) }));
    }
  };

  const openS3Config = () => {
    const config = settings.data?.config;
    setS3Draft(config ? {
      endpoint: config.endpoint,
      region: config.region,
      bucket: config.bucket,
      prefix: config.prefix,
      accessKeyId: config.accessKeyId,
      secretAccessKey: "",
      pathStyle: config.pathStyle,
    } : { ...EMPTY_S3_DRAFT });
  };

  const currentS3Input = (): S3SyncConfigInput | null => s3Draft ? {
    ...s3Draft,
    secretAccessKey: s3Draft.secretAccessKey.trim() || null,
  } : null;

  const saveS3Config = async () => {
    const config = currentS3Input();
    if (!config) return;
    try {
      await transfer.saveS3Config.mutateAsync(config);
      Toast.success(t("S3 同步配置已保存"));
      setS3Draft(null);
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: errorMessage(error) }));
    }
  };

  const testS3Connection = async () => {
    const config = currentS3Input();
    if (!config) return;
    try {
      const result = await transfer.testS3Connection.mutateAsync(config);
      Toast.success(result.message);
    } catch (error) {
      Toast.error(t("连接测试失败：{message}", { message: errorMessage(error) }));
    }
  };

  const syncS3 = async () => {
    try {
      const result = await transfer.syncS3.mutateAsync();
      Toast.success(t("同步完成：发现 {devices} 台设备，导入 {days} 天", {
        devices: result.remoteDevices,
        days: result.importedDays,
      }));
    } catch (error) {
      Toast.error(t("同步失败：{message}", { message: errorMessage(error) }));
    }
  };

  const openShare = async () => {
    try {
      const config = await transfer.exportS3ConnectionConfig.mutateAsync();
      setSharePackage({
        text: serializeS3ConnectionPackage(config),
        qr: serializeS3ConnectionPackage(config, true),
      });
    } catch (error) {
      Toast.error(t("生成连接包失败：{message}", { message: errorMessage(error) }));
    }
  };

  const copyConnectionText = async () => {
    if (!sharePackage) return;
    try {
      await navigator.clipboard.writeText(sharePackage.text);
      Toast.success(t("S3 连接文本已复制"));
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: errorMessage(error) }));
    }
  };

  const importConnection = async () => {
    const config = parsedConnection?.config;
    if (!config) return;
    try {
      await transfer.testS3Connection.mutateAsync(config);
      await transfer.saveS3Config.mutateAsync(config);
      setConnectionText(null);
      Toast.success(t("S3 连接配置已导入并通过测试"));
    } catch (error) {
      Toast.error(t("导入连接配置失败：{message}", { message: errorMessage(error) }));
    }
  };

  return (
    <div className={styles.root}>
      <section className={styles.card} data-keywords="S3 R2 MinIO 对象存储 同步 连接 二维码">
        <header className={styles.sectionHeader}>
          <div>
            <div className={styles.deviceTitle}>
              <strong>{t("S3-compatible 同步")}</strong>
              <SyncStatusTag status={settings.data?.status.status ?? "never"} />
            </div>
            <span>{t("每台设备只写自己的快照对象，Secret Access Key 保存在系统凭据库")}</span>
          </div>
          <div className={styles.actions}>
            <Button theme="outline" onClick={openS3Config}>{settings.data?.config ? t("修改配置") : t("配置 S3")}</Button>
            <Button
              type="primary"
              theme="solid"
              disabled={!settings.data?.config}
              loading={transfer.syncS3.isPending}
              onClick={() => void syncS3()}
            >
              {t("立即同步")}
            </Button>
          </div>
        </header>
        <div className={styles.s3Summary}>
          {settings.data?.config ? <>
            <div><span>Endpoint</span><code>{settings.data.config.endpoint}</code></div>
            <div><span>Bucket</span><strong>{settings.data.config.bucket}</strong></div>
            <div><span>{t("路径")}</span><strong>{settings.data.config.prefix || "flowlet/"}</strong></div>
            <div><span>{t("最近同步")}</span><strong>{formatSyncTime(settings.data.status.lastSuccessAt)}</strong></div>
            <p>{settings.data.status.message}</p>
          </> : <div className={styles.empty}>{t("尚未配置远程同步。支持 AWS S3、Cloudflare R2、Backblaze B2 和 MinIO。")}</div>}
          {settings.isError ? <div className={styles.empty}>{t("S3 同步设置加载失败")}</div> : null}
        </div>
        <div className={styles.connectStrip}>
          <div>
            <strong>{t("快速连接其它设备")}</strong>
            <span>{t("通过二维码连接手机，或复制完整连接文本到另一台桌面设备")}</span>
          </div>
          <div className={styles.actions}>
            <Button theme="outline" onClick={() => setConnectionText("")}>{t("导入连接文本")}</Button>
            <Button
              icon={<IconQrCode />}
              type="primary"
              theme="solid"
              disabled={!settings.data?.config}
              loading={transfer.exportS3ConnectionConfig.isPending}
              onClick={() => void openShare()}
            >
              {t("连接新设备")}
            </Button>
          </div>
        </div>
      </section>

      <section className={styles.card} data-keywords="设备 ID 导入 导出 多设备 用量">
        <header className={styles.sectionHeader}>
          <div>
            <strong>{t("设备与用量共享")}</strong>
            <span>{t("当前仅共享设备身份和每日 Token 汇总，不包含费用、账号或请求明细")}</span>
          </div>
          <div className={styles.actions}>
            <Button theme="outline" onClick={() => void chooseUsageImport()} loading={transfer.previewImport.isPending}>{t("导入设备用量")}</Button>
            <Button type="primary" theme="solid" onClick={() => void exportUsage()} loading={transfer.exportBundle.isPending}>{t("导出当前设备")}</Button>
          </div>
        </header>
        <div className={styles.deviceList}>
          {(devices.data ?? []).map((device) => (
            <article className={styles.deviceCard} key={device.deviceId}>
              <div className={styles.deviceGlyph}>{t(device.isCurrent ? "本" : "设")}</div>
              <div className={styles.deviceCopy}>
                <div className={styles.deviceTitle}>
                  <strong>{device.displayName}</strong>
                  {device.isCurrent ? <Tag color="blue" size="small">{t("当前设备")}</Tag> : <Tag size="small">{t("已导入")}</Tag>}
                  {device.isCurrent ? <Button theme="borderless" size="small" onClick={() => setRenameValue(device.displayName)}>{t("重命名")}</Button> : null}
                </div>
                <code title={device.deviceId}>{device.deviceId}</code>
                <span>
                  {platformLabel(device.platform)}
                  {device.appVersion !== "unknown" ? ` · Flowlet ${device.appVersion}` : ""}
                  {" · "}
                  {device.firstUsageDate && device.lastUsageDate ? `${device.firstUsageDate} — ${device.lastUsageDate}` : t("暂无用量")}
                </span>
              </div>
              <div className={styles.deviceStats}>
                <strong>{formatCompactNumber(device.knownTokens, language)}</strong>
                <span>Tokens · {t("{count} 次请求", { count: device.requestCount })}</span>
              </div>
            </article>
          ))}
          {devices.isLoading ? <div className={styles.state}>{t("正在读取设备信息…")}</div> : null}
          {devices.isError ? <div className={styles.state}>{t("设备信息加载失败")}</div> : null}
        </div>
      </section>

      <SideSheet
        title={(
          <div className={styles.sideSheetTitle}>
            <strong>{t("连接新设备")}</strong>
            <span>{t("使用二维码连接移动端，或复制连接文本到另一台桌面设备")}</span>
          </div>
        )}
        visible={sharePackage != null}
        motion={false}
        zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
        width="min(720px, 96vw)"
        bodyStyle={{ padding: 0 }}
        footer={null}
        onCancel={() => setSharePackage(null)}
      >
        {sharePackage ? <div className={styles.shareSideSheetBody}>
          <p className={styles.secretNotice}>{t("二维码和连接文本包含 Secret Access Key，将在 60 秒后自动关闭。仅在可信设备上使用，不要截图、转发或粘贴到聊天工具。")}</p>
          <div className={styles.shareLayout}>
            <div className={styles.qrPanel}>
              <QRCodeSVG value={sharePackage.qr} size={224} level="M" marginSize={1} />
              <span>{t("使用 Flowlet 移动端扫描")}</span>
            </div>
            <div className={styles.textPanel}>
              <TextArea value={sharePackage.text} readonly autosize={{ minRows: 18, maxRows: 24 }} />
              <Button icon={<IconCopy />} type="primary" theme="solid" onClick={() => void copyConnectionText()}>{t("复制完整连接文本")}</Button>
            </div>
          </div>
        </div> : null}
      </SideSheet>

      <Modal
        title={t("导入 S3 连接文本")}
        visible={connectionText != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        width={580}
        onCancel={() => setConnectionText(null)}
        onOk={() => void importConnection()}
        okText={t("测试并导入")}
        cancelText={t("取消")}
        okButtonProps={{
          disabled: !parsedConnection?.config,
          loading: transfer.testS3Connection.isPending || transfer.saveS3Config.isPending,
        }}
      >
        <p className={styles.secretNotice}>{t("只导入来自可信设备的连接文本。导入前会验证 S3 的完整读写权限。")}</p>
        <div className={styles.textPanel}>
          <TextArea
            autoFocus
            value={connectionText ?? ""}
            placeholder={t("粘贴 Flowlet S3 连接包 JSON")}
            autosize={{ minRows: 10, maxRows: 10 }}
            onChange={setConnectionText}
          />
          {parsedConnection ? <div className={styles.importResult}>
            {parsedConnection.config ? <>
              <strong>{parsedConnection.config.bucket}</strong>
              <span>{parsedConnection.config.endpoint} · {parsedConnection.config.prefix || "flowlet/"}</span>
            </> : <span className={styles.importError}>{parsedConnection.error}</span>}
          </div> : null}
        </div>
      </Modal>

      <Modal
        title={t("导入设备每日用量")}
        visible={preview != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => { setPreview(null); setImportPath(null); }}
        onOk={() => void applyUsageImport()}
        okButtonProps={{ loading: transfer.importBundle.isPending, disabled: preview?.sameAsCurrentDevice }}
        okText={t("确认导入")}
        cancelText={t("取消")}
      >
        {preview ? <div className={styles.preview}>
          <div><span>{t("来源设备")}</span><code>{preview.deviceId}</code></div>
          <div><span>{t("设备名称")}</span><strong>{preview.displayName}</strong></div>
          <div><span>{t("设备环境")}</span><strong>{platformLabel(preview.platform)}{preview.appVersion !== "unknown" ? ` · Flowlet ${preview.appVersion}` : ""}</strong></div>
          <div><span>{t("日期范围")}</span><strong>{preview.firstDate && preview.lastDate ? `${preview.firstDate} — ${preview.lastDate}` : t("无数据")}</strong></div>
          <div><span>{t("每日汇总")}</span><strong>{t("{count} 天", { count: preview.dayCount })}</strong></div>
          <div><span>{t("导入变化")}</span><strong>{t("新增 {newCount} · 更新 {updatedCount} · 不变 {sameCount}", { newCount: preview.newDays, updatedCount: preview.updatedDays, sameCount: preview.unchangedDays })}</strong></div>
          {preview.sameAsCurrentDevice ? <p className={styles.warning}>{t("这是当前设备导出的文件，不能重新导入为其它设备。")}</p> : null}
        </div> : null}
      </Modal>

      <S3ConfigSideSheet
        draft={s3Draft}
        secretConfigured={Boolean(settings.data?.config?.secretConfigured)}
        saving={transfer.saveS3Config.isPending}
        testing={transfer.testS3Connection.isPending}
        onChange={setS3Draft}
        onCancel={() => setS3Draft(null)}
        onSave={() => void saveS3Config()}
        onTest={() => void testS3Connection()}
        t={t}
      />

      <Modal
        title={t("重命名当前设备")}
        visible={renameValue != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => setRenameValue(null)}
        onOk={() => void applyRename()}
        okButtonProps={{ loading: transfer.renameCurrentDevice.isPending, disabled: !renameValue?.trim() }}
        okText={t("保存")}
        cancelText={t("取消")}
      >
        <div className={styles.renameForm}>
          <span>{t("设备名称用于导出和同步时区分设备，不会改变设备 ID。")}</span>
          <Input
            autoFocus
            value={renameValue ?? ""}
            maxLength={64}
            showClear
            placeholder={t("例如：公司笔记本")}
            onChange={setRenameValue}
            onEnterPress={() => { if (renameValue?.trim()) void applyRename(); }}
          />
        </div>
      </Modal>
    </div>
  );
}

type Translate = (key: string, params?: Record<string, string | number>) => string;

function S3ConfigSideSheet({
  draft,
  secretConfigured,
  saving,
  testing,
  onChange,
  onCancel,
  onSave,
  onTest,
  t,
}: {
  draft: S3Draft | null;
  secretConfigured: boolean;
  saving: boolean;
  testing: boolean;
  onChange: (draft: S3Draft | null) => void;
  onCancel: () => void;
  onSave: () => void;
  onTest: () => void;
  t: Translate;
}) {
  const saveDisabled = !draft?.endpoint.trim() || !draft?.bucket.trim() || !draft?.accessKeyId.trim();

  return <SideSheet
    title={(
      <div className={styles.sideSheetTitle}>
        <strong>{t("配置 S3-compatible 同步")}</strong>
        <span>{t("连接你自己的对象存储，在设备之间共享每日用量")}</span>
      </div>
    )}
    visible={draft != null}
    motion={false}
    zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
    width="min(600px, 96vw)"
    bodyStyle={{ padding: 0 }}
    onCancel={onCancel}
    footer={(
      <div className={styles.sideSheetFooter}>
        <Button onClick={onCancel}>{t("取消")}</Button>
        <Button
          theme="solid"
          type="primary"
          loading={saving}
          disabled={saveDisabled}
          onClick={onSave}
        >
          {t("保存配置")}
        </Button>
      </div>
    )}
  >
    {draft ? <div className={`${styles.form} ${styles.sideSheetBody}`}>
      <label>
        <span>Endpoint</span>
        <Input value={draft.endpoint} placeholder="https://<account-id>.r2.cloudflarestorage.com" onChange={(endpoint) => onChange({ ...draft, endpoint })} />
        <small className={styles.fieldHint}>{t("填写服务 Endpoint，不要包含 Bucket 名；阿里云 OSS 请使用 S3-compatible Endpoint。")}</small>
      </label>
      <div className={styles.formGrid}>
        <label><span>Region</span><Input value={draft.region} placeholder="auto / us-east-1" onChange={(region) => onChange({ ...draft, region })} /></label>
        <label><span>Bucket</span><Input value={draft.bucket} placeholder="flowlet-sync" onChange={(bucket) => onChange({ ...draft, bucket })} /></label>
      </div>
      <label><span>{t("路径前缀（可选）")}</span><Input value={draft.prefix} placeholder="users/me" showClear onChange={(prefix) => onChange({ ...draft, prefix })} /></label>
      <label><span>Access Key ID</span><Input value={draft.accessKeyId} onChange={(accessKeyId) => onChange({ ...draft, accessKeyId })} /></label>
      <label>
        <span>Secret Access Key</span>
        <Input
          mode="password"
          value={draft.secretAccessKey}
          placeholder={secretConfigured ? t("已安全保存，留空则保持不变") : t("请输入 Secret Access Key")}
          onChange={(secretAccessKey) => onChange({ ...draft, secretAccessKey })}
        />
      </label>
      <div className={styles.switchRow}>
        <div className={styles.switchCopy}>
          <strong>{t("使用 Path-style 地址")}</strong>
          <span id="s3-path-style-description">{t("MinIO 和部分兼容服务需要开启；AWS 通常关闭")}</span>
        </div>
        <Switch
          className={styles.switchControl}
          checked={draft.pathStyle}
          aria-label={t("使用 Path-style 地址")}
          aria-describedby="s3-path-style-description"
          onChange={(pathStyle) => onChange({ ...draft, pathStyle })}
        />
      </div>
      <div className={styles.permissions}>
        <strong>{t("所需权限")}</strong>
        <span>{t("Bucket：oss:HeadBucket、oss:GetBucketInfo、oss:ListObjects；对象：oss:GetObject、oss:PutObject、oss:DeleteObject")}</span>
      </div>
      <div className={styles.testRow}>
        <span>{t("测试会临时写入、读取并删除一个小对象，以验证完整权限。")}</span>
        <Button theme="outline" loading={testing} onClick={onTest}>{t("测试连接")}</Button>
      </div>
    </div> : null}
  </SideSheet>;
}

function platformLabel(platform: string) {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "linux") return "Linux";
  if (platform === "android") return "Android";
  if (platform === "ios") return "iOS";
  return "Flowlet";
}

function formatSyncTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function SyncStatusTag({ status }: { status: string }) {
  const { t } = useAppPreferences();
  if (status === "success") return <Tag color="green" size="small">{t("已同步")}</Tag>;
  if (status === "partial") return <Tag color="orange" size="small">{t("部分成功")}</Tag>;
  if (status === "failed") return <Tag color="red" size="small">{t("失败")}</Tag>;
  if (status === "running") return <Tag color="blue" size="small">{t("同步中")}</Tag>;
  return <Tag size="small">{t("未同步")}</Tag>;
}
