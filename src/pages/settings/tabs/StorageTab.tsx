import { Button, Input, Modal, Switch, Tag, Toast } from "@douyinfe/semi-ui-19";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useState } from "react";
import { useStorageUsage } from "../../../features/settings/useStorageUsage";
import { useStorageMaintenance } from "../../../features/settings/useStorageMaintenance";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";
import { useDeviceUsageTransfer, useKnownDevices, useS3SyncSettings } from "../../../features/device-sync/useDeviceSync";
import type { DeviceUsageImportPreview, S3SyncConfigInput } from "../../../domains/device-sync/types";
import { APP_OVERLAY_Z_INDEX } from "../../../shared/ui/overlayLayers";
import { formatCompactNumber } from "../../../shared/formatters/number";
import styles from "./StorageTab.module.css";

const CATEGORY_LABELS: Record<string, string> = {
  configuration: "配置与账号",
  requestLogs: "请求日志",
  requestCaptures: "请求明细文件",
  usage: "用量与费用",
  agentSessions: "Agent 会话",
  backgroundTasks: "后台任务",
  bodyData: "请求与响应 Body（按策略自动清理）",
};

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

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unitIndex;
  return `${value >= 10 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[unitIndex]}`;
}

export function StorageTab() {
  const { language, t } = useAppPreferences();
  const usage = useStorageUsage();
  const maintenance = useStorageMaintenance();
  const devices = useKnownDevices();
  const s3Settings = useS3SyncSettings();
  const transfer = useDeviceUsageTransfer();
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeviceUsageImportPreview | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [s3Draft, setS3Draft] = useState<S3Draft | null>(null);

  const data = usage.isCounting ? usage.progress : (usage.data ?? usage.progress);
  const hasReclaimable = data.reclaimableBytes >= 1024 * 1024;
  const exportUsage = async () => {
    const path = await save({
      defaultPath: `flowlet-usage-${new Date().toISOString().slice(0, 10)}.flowlet.json`,
      filters: [{ name: "Flowlet 设备用量", extensions: ["json"] }],
    });
    if (!path) return;
    try {
      await transfer.exportBundle.mutateAsync(path);
      Toast.success(t("设备用量已导出"));
    } catch (error) {
      Toast.error(t("导出失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const chooseImport = async () => {
    const path = await open({
      multiple: false,
      directory: false,
      filters: [{ name: "Flowlet 设备用量", extensions: ["json"] }],
    });
    if (typeof path !== "string") return;
    try {
      const result = await transfer.previewImport.mutateAsync(path);
      setImportPath(path);
      setPreview(result);
    } catch (error) {
      Toast.error(t("读取导入文件失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const applyImport = async () => {
    if (!importPath || !preview) return;
    try {
      const result = await transfer.importBundle.mutateAsync(importPath);
      Toast.success(t("已导入 {count} 天设备用量", { count: result.importedDays }));
      setImportPath(null);
      setPreview(null);
    } catch (error) {
      Toast.error(t("导入失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const applyRename = async () => {
    if (renameValue == null) return;
    try {
      await transfer.renameCurrentDevice.mutateAsync(renameValue.trim());
      Toast.success(t("设备名称已更新"));
      setRenameValue(null);
    } catch (error) {
      Toast.error(t("重命名失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const openS3Config = () => {
    const config = s3Settings.data?.config;
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
  const s3Input = (): S3SyncConfigInput | null => s3Draft ? {
    ...s3Draft,
    secretAccessKey: s3Draft.secretAccessKey.trim() || null,
  } : null;
  const saveS3Config = async () => {
    const config = s3Input();
    if (!config) return;
    try {
      await transfer.saveS3Config.mutateAsync(config);
      Toast.success(t("S3 同步配置已保存"));
      setS3Draft(null);
    } catch (error) {
      Toast.error(t("保存失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };
  const testS3Connection = async () => {
    const config = s3Input();
    if (!config) return;
    try {
      const result = await transfer.testS3Connection.mutateAsync(config);
      Toast.success(result.message);
    } catch (error) {
      Toast.error(t("连接测试失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
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
      Toast.error(t("同步失败：{message}", { message: error instanceof Error ? error.message : String(error) }));
    }
  };

  return (
    <div>
      <section className={styles.deviceSection} data-keywords="设备 ID 导入 导出 多设备 用量">
        <header className={styles.sectionHeader}>
          <div>
            <strong>{t("设备与用量共享")}</strong>
            <span>{t("当前仅共享设备身份和每日 Token 汇总，不包含费用、账号或请求明细")}</span>
          </div>
          <div className={styles.deviceActions}>
            <Button onClick={() => void chooseImport()} loading={transfer.previewImport.isPending}>{t("导入设备用量")}</Button>
            <Button type="primary" onClick={() => void exportUsage()} loading={transfer.exportBundle.isPending}>{t("导出当前设备")}</Button>
          </div>
        </header>
        <div className={styles.deviceList}>
          {(devices.data ?? []).map((device) => (
            <article className={styles.deviceCard} key={device.deviceId}>
              <div className={styles.deviceGlyph}>{device.isCurrent ? "本" : "设"}</div>
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
          {devices.isLoading ? <div className={styles.deviceState}>{t("正在读取设备信息…")}</div> : null}
          {devices.isError ? <div className={styles.deviceState}>{t("设备信息加载失败")}</div> : null}
        </div>
      </section>

      <section className={styles.s3Section} data-keywords="S3 R2 MinIO 对象存储 同步">
        <header className={styles.sectionHeader}>
          <div>
            <div className={styles.deviceTitle}>
              <strong>{t("S3-compatible 同步")}</strong>
              <SyncStatusTag status={s3Settings.data?.status.status ?? "never"} />
            </div>
            <span>{t("每台设备只写自己的快照对象，Secret Access Key 保存在系统凭据库")}</span>
          </div>
          <div className={styles.deviceActions}>
            <Button onClick={openS3Config}>{s3Settings.data?.config ? t("修改配置") : t("配置 S3")}</Button>
            <Button
              type="primary"
              disabled={!s3Settings.data?.config}
              loading={transfer.syncS3.isPending}
              onClick={() => void syncS3()}
            >
              {t("立即同步")}
            </Button>
          </div>
        </header>
        <div className={styles.s3Summary}>
          {s3Settings.data?.config ? <>
            <div><span>Endpoint</span><code>{s3Settings.data.config.endpoint}</code></div>
            <div><span>Bucket</span><strong>{s3Settings.data.config.bucket}</strong></div>
            <div><span>{t("路径")}</span><strong>{s3Settings.data.config.prefix || "flowlet/"}</strong></div>
            <div><span>{t("最近同步")}</span><strong>{formatSyncTime(s3Settings.data.status.lastSuccessAt)}</strong></div>
            <p>{s3Settings.data.status.message}</p>
          </> : <div className={styles.s3Empty}>{t("尚未配置远程同步。支持 AWS S3、Cloudflare R2、Backblaze B2 和 MinIO。")}</div>}
          {s3Settings.isError ? <div className={styles.s3Empty}>{t("S3 同步设置加载失败")}</div> : null}
        </div>
      </section>

      <div className={styles.summaryCard} data-keywords="存储空间 当前使用 清理 Body">
        <div className={styles.summaryMain}>
          <div className={styles.summaryLabel}>{t("当前本地数据占用")}</div>
          <div className={styles.summaryValue}>{formatBytes(data.totalBytes)}</div>
          <div className={styles.summaryMeta}>{t("请求与响应 Body 占用了 72% 的存储空间")}</div>
          <div className={styles.progressTrack}>
            <div className={styles.progressFill} style={{ width: "72%" }} />
          </div>
        </div>
        <div className={styles.summaryActions}>
          {hasReclaimable ? <span className={styles.recommend}>{t("预计可释放 {size}", { size: formatBytes(data.reclaimableBytes) })}</span> : null}
          <Button
            type="primary"
            loading={maintenance.isPending}
            disabled={usage.isCounting || !hasReclaimable}
          >
            {t("清理建议")}
          </Button>
        </div>
      </div>

      <table className={styles.table} data-keywords="配置账号 请求日志 用量费用 Agent 会话 后台任务 Body">
        <thead>
          <tr>
            <th>{t("数据类型")}</th>
            <th className={styles.num}>{t("记录数")}</th>
            <th className={styles.num}>{t("占用空间")}</th>
            <th>{t("最近更新")}</th>
            <th className={styles.action}>{t("操作")}</th>
          </tr>
        </thead>
        <tbody>
          {data.categories.map((category: { key: string; rowCount: number; allocatedBytes: number }, index: number) => (
            <tr key={category.key}>
              <td>
                <div className={styles.dataName}>
                  <i className={styles.dataDot} style={{ opacity: 1 - index * 0.13 }} />
                  {t(CATEGORY_LABELS[category.key] ?? category.key)}
                </div>
              </td>
              <td className={styles.num}>{category.rowCount.toLocaleString()}</td>
              <td className={styles.num}>{formatBytes(category.allocatedBytes)}</td>
              <td>{t("刚刚")}</td>
              <td className={styles.action}><button type="button" className={styles.tableAction}>{t("清理")}</button></td>
            </tr>
          ))}
        </tbody>
      </table>

      <Modal
        title={t("导入设备每日用量")}
        visible={preview != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => { setPreview(null); setImportPath(null); }}
        onOk={() => void applyImport()}
        okButtonProps={{ loading: transfer.importBundle.isPending, disabled: preview?.sameAsCurrentDevice }}
        okText={t("确认导入")}
        cancelText={t("取消")}
      >
        {preview ? <div className={styles.importPreview}>
          <div><span>{t("来源设备")}</span><code>{preview.deviceId}</code></div>
          <div><span>{t("设备名称")}</span><strong>{preview.displayName}</strong></div>
          <div><span>{t("设备环境")}</span><strong>{platformLabel(preview.platform)}{preview.appVersion !== "unknown" ? ` · Flowlet ${preview.appVersion}` : ""}</strong></div>
          <div><span>{t("日期范围")}</span><strong>{preview.firstDate && preview.lastDate ? `${preview.firstDate} — ${preview.lastDate}` : t("无数据")}</strong></div>
          <div><span>{t("每日汇总")}</span><strong>{t("{count} 天", { count: preview.dayCount })}</strong></div>
          <div><span>{t("导入变化")}</span><strong>{t("新增 {newCount} · 更新 {updatedCount} · 不变 {sameCount}", { newCount: preview.newDays, updatedCount: preview.updatedDays, sameCount: preview.unchangedDays })}</strong></div>
          {preview.sameAsCurrentDevice ? <p className={styles.importWarning}>{t("这是当前设备导出的文件，不能重新导入为其它设备。")}</p> : null}
        </div> : null}
      </Modal>

      <Modal
        title={t("配置 S3-compatible 同步")}
        visible={s3Draft != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        width={560}
        onCancel={() => setS3Draft(null)}
        onOk={() => void saveS3Config()}
        okButtonProps={{
          loading: transfer.saveS3Config.isPending,
          disabled: !s3Draft?.endpoint.trim() || !s3Draft?.bucket.trim() || !s3Draft?.accessKeyId.trim(),
        }}
        okText={t("保存配置")}
        cancelText={t("取消")}
      >
        {s3Draft ? <div className={styles.s3Form}>
          <label>
            <span>Endpoint</span>
            <Input value={s3Draft.endpoint} placeholder="https://<account-id>.r2.cloudflarestorage.com" onChange={(endpoint) => setS3Draft({ ...s3Draft, endpoint })} />
          </label>
          <div className={styles.s3FormGrid}>
            <label>
              <span>Region</span>
              <Input value={s3Draft.region} placeholder="auto / us-east-1" onChange={(region) => setS3Draft({ ...s3Draft, region })} />
            </label>
            <label>
              <span>Bucket</span>
              <Input value={s3Draft.bucket} placeholder="flowlet-sync" onChange={(bucket) => setS3Draft({ ...s3Draft, bucket })} />
            </label>
          </div>
          <label>
            <span>{t("路径前缀（可选）")}</span>
            <Input value={s3Draft.prefix} placeholder="users/me" showClear onChange={(prefix) => setS3Draft({ ...s3Draft, prefix })} />
          </label>
          <label>
            <span>Access Key ID</span>
            <Input value={s3Draft.accessKeyId} onChange={(accessKeyId) => setS3Draft({ ...s3Draft, accessKeyId })} />
          </label>
          <label>
            <span>Secret Access Key</span>
            <Input
              mode="password"
              value={s3Draft.secretAccessKey}
              placeholder={s3Settings.data?.config?.secretConfigured ? t("已安全保存，留空则保持不变") : t("请输入 Secret Access Key")}
              onChange={(secretAccessKey) => setS3Draft({ ...s3Draft, secretAccessKey })}
            />
          </label>
          <div className={styles.s3SwitchRow}>
            <div><strong>{t("使用 Path-style 地址")}</strong><span>{t("MinIO 和部分兼容服务需要开启；AWS 通常关闭")}</span></div>
            <Switch checked={s3Draft.pathStyle} onChange={(pathStyle) => setS3Draft({ ...s3Draft, pathStyle })} />
          </div>
          <div className={styles.s3TestRow}>
            <span>{t("测试会临时写入、读取并删除一个小对象，以验证完整权限。")}</span>
            <Button loading={transfer.testS3Connection.isPending} onClick={() => void testS3Connection()}>{t("测试连接")}</Button>
          </div>
        </div> : null}
      </Modal>

      <Modal
        title={t("重命名当前设备")}
        visible={renameValue != null}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => setRenameValue(null)}
        onOk={() => void applyRename()}
        okButtonProps={{
          loading: transfer.renameCurrentDevice.isPending,
          disabled: !renameValue?.trim(),
        }}
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
            onEnterPress={() => {
              if (renameValue?.trim()) void applyRename();
            }}
          />
        </div>
      </Modal>
    </div>
  );
}

function platformLabel(platform: string) {
  if (platform === "windows") return "Windows";
  if (platform === "macos") return "macOS";
  if (platform === "linux") return "Linux";
  return "Flowlet";
}

function formatSyncTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function SyncStatusTag({ status }: { status: string }) {
  if (status === "success") return <Tag color="green" size="small">已同步</Tag>;
  if (status === "partial") return <Tag color="orange" size="small">部分成功</Tag>;
  if (status === "failed") return <Tag color="red" size="small">失败</Tag>;
  if (status === "running") return <Tag color="blue" size="small">同步中</Tag>;
  return <Tag size="small">未同步</Tag>;
}
