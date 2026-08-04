import { IconCopy, IconMore, IconPlus, IconRefresh } from "@douyinfe/semi-icons";
import { Button, Checkbox, Dropdown, Input, Modal, SideSheet, Switch, Tabs, Tag, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { useQueryClient } from "@tanstack/react-query";
import { open, save } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useAppPreferences } from "../../../app/preferences/AppPreferences";
import {
  parseSyncPackage,
  serializeDesktopWorkspacePackage,
  DESKTOP_WORKSPACE_PACKAGE_FORMAT,
} from "../../../domains/account-workspace/syncPackage";
import { serializeS3ConnectionPackage } from "../../../domains/device-sync/s3ConnectionPackage";
import type {
  DeviceUsageImportPreview,
  S3SyncConfigInput,
} from "../../../domains/device-sync/types";
import { useAccountWorkspaceSync } from "../../../features/channel-accounts/useAccountWorkspaceSync";
import {
  useDeviceUsageTransfer,
  useKnownDevices,
  useLanProbes,
  useLanServerStatus,
  useS3SyncSettings,
} from "../../../features/device-sync/useDeviceSync";
import { errorMessage } from "../../../shared/errors/AppError";
import { formatFullTimestamp } from "../../../shared/formatters/datetime";
import { formatCompactNumber } from "../../../shared/formatters/number";
import { queryKeys } from "../../../shared/query-keys";
import { APP_OVERLAY_Z_INDEX } from "../../../shared/ui/overlayLayers";
import styles from "./SyncTab.module.css";

type S3Draft = Omit<S3SyncConfigInput, "secretAccessKey"> & { secretAccessKey: string };
type ConnectionTab = "qr" | "text" | "import";

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
  const queryClient = useQueryClient();
  const devices = useKnownDevices();
  const settings = useS3SyncSettings();
  const transfer = useDeviceUsageTransfer();
  const lanStatus = useLanServerStatus();
  const lanProbes = useLanProbes();
  const accountWorkspace = useAccountWorkspaceSync();
  const workspaceEnabled = Boolean(accountWorkspace.status.data?.enabled);
  const [importPath, setImportPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<DeviceUsageImportPreview | null>(null);
  const [renameValue, setRenameValue] = useState<string | null>(null);
  const [s3Draft, setS3Draft] = useState<S3Draft | null>(null);
  const [sharePackage, setSharePackage] = useState<{ text: string; qr: string } | null>(null);
  const [connectionText, setConnectionText] = useState<string | null>(null);
  const [connectionTab, setConnectionTab] = useState<ConnectionTab | null>(null);
  const [expiresIn, setExpiresIn] = useState(60);
  const [workspaceConsentVisible, setWorkspaceConsentVisible] = useState(false);
  const [includeWorkspace, setIncludeWorkspace] = useState(false);

  const parsedPackage = useMemo(() => {
    if (connectionText == null || !connectionText.trim()) return null;
    try {
      return { result: parseSyncPackage(connectionText), error: null as string | null };
    } catch (error) {
      return { result: null, error: errorMessage(error) };
    }
  }, [connectionText]);

  useEffect(() => {
    if (!sharePackage) return undefined;
    setExpiresIn(60);
    const timer = window.setInterval(() => {
      setExpiresIn((current) => {
        if (current > 1) return current - 1;
        window.clearInterval(timer);
        setSharePackage(null);
        setConnectionTab(null);
        return 0;
      });
    }, 1_000);
    return () => window.clearInterval(timer);
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

  const refreshDevices = async () => {
    try {
      const result = await devices.refetch();
      if (result.isError) {
        Toast.error(t("刷新设备列表失败：{message}", { message: errorMessage(result.error) }));
        return;
      }
      Toast.success(t("设备列表已刷新"));
    } catch (error) {
      Toast.error(t("刷新设备列表失败：{message}", { message: errorMessage(error) }));
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

  const generateShare = async (tab: Extract<ConnectionTab, "qr" | "text">, withWorkspace: boolean) => {
    setConnectionTab(tab);
    try {
      if (withWorkspace) {
        const accountPackage = await accountWorkspace.exportDesktopPackage.mutateAsync();
        setSharePackage({
          text: serializeDesktopWorkspacePackage(accountPackage),
          qr: serializeDesktopWorkspacePackage(accountPackage, true),
        });
      } else {
        const config = await transfer.exportS3ConnectionConfig.mutateAsync();
        setSharePackage({
          text: serializeS3ConnectionPackage(config),
          qr: serializeS3ConnectionPackage(config, true),
        });
      }
    } catch (error) {
      setConnectionTab(null);
      Toast.error(t("生成连接包失败：{message}", { message: errorMessage(error) }));
    }
  };

  const openShare = (tab: Extract<ConnectionTab, "qr" | "text"> = "qr") => {
    void generateShare(tab, tab === "text" && includeWorkspace);
  };

  const toggleIncludeWorkspace = (checked: boolean) => {
    setIncludeWorkspace(checked);
    if (connectionTab === "text") {
      setSharePackage(null);
      void generateShare("text", checked);
    }
  };

  const openConnectionImport = () => {
    setConnectionText("");
    setConnectionTab("import");
  };

  const closeConnectionDialog = () => {
    setConnectionTab(null);
    setSharePackage(null);
    setConnectionText(null);
    setIncludeWorkspace(false);
  };

  const copyConnectionText = async () => {
    if (!sharePackage) return;
    try {
      await navigator.clipboard.writeText(sharePackage.text);
      Toast.success(t(sharePackage.text.includes(DESKTOP_WORKSPACE_PACKAGE_FORMAT)
        ? "账号工作区连接文本已复制"
        : "S3 连接文本已复制"));
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: errorMessage(error) }));
    }
  };

  const importConnection = async () => {
    const parsed = parsedPackage?.result;
    if (!parsed) return;
    try {
      if (parsed.kind === "workspace") {
        // 工作区接入包内嵌 S3 连接配置，Rust 端导入时会一并写入并立即同步；
        // 拉取远端工作区对象本身就完成了凭据与连通性校验。
        const result = await accountWorkspace.importDesktopPackage.mutateAsync(parsed.package);
        await queryClient.invalidateQueries({ queryKey: queryKeys.deviceSync.s3Settings() });
        closeConnectionDialog();
        Toast.success(t("已加入账号工作区，同步 {count} 个账号", { count: result.accountCount }));
        return;
      }
      await transfer.testS3Connection.mutateAsync(parsed.config);
      await transfer.saveS3Config.mutateAsync(parsed.config);
      closeConnectionDialog();
      Toast.success(t("S3 连接配置已导入并通过测试"));
    } catch (error) {
      Toast.error(t("导入连接配置失败：{message}", { message: errorMessage(error) }));
    }
  };

  const initializeAccountWorkspace = async () => {
    try {
      const result = await accountWorkspace.initialize.mutateAsync();
      setWorkspaceConsentVisible(false);
      Toast.success(t("账号工作区已启用，已统一管理 {count} 个账号", { count: result.linkedAccounts }));
    } catch (error) {
      Toast.error(t("启用失败：{message}", { message: errorMessage(error) }));
    }
  };

  const syncAccountWorkspace = async () => {
    try {
      const result = await accountWorkspace.sync.mutateAsync();
      Toast.success(t("账号工作区已同步，共 {count} 个账号", { count: result.accountCount }));
    } catch (error) {
      Toast.error(t("同步失败：{message}", { message: errorMessage(error) }));
    }
  };

  return (
    <div className={styles.root}>
      <section className={styles.card} data-keywords="S3 R2 MinIO 对象存储 同步 连接 二维码">
        <header className={styles.sectionHeader}>
          <div>
            <div className={styles.deviceTitle}>
              <strong>{t("云端同步")}</strong>
              <SyncStatusTag status={settings.data?.status.status ?? "never"} />
            </div>
            <span>{t("将本地数据同步至 S3 兼容存储")}</span>
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
          </> : <div className={styles.empty}>{t("尚未配置远程同步。支持 AWS S3、Cloudflare R2、Backblaze B2 和 MinIO。")}</div>}
          {settings.isError ? <div className={styles.empty}>{t("S3 同步设置加载失败")}</div> : null}
        </div>
        {settings.data?.config ? (
          <div className={styles.syncFoot}>
            <span className={styles.syncDot} />
            <span>{settings.data.status.message}</span>
          </div>
        ) : null}
        <div className={styles.workspacePanel}>
          <div className={styles.workspaceCopy}>
            <div className={styles.deviceTitle}>
              <strong>{t("渠道账号工作区")}</strong>
              {accountWorkspace.status.data?.enabled
                ? <Tag color="blue" size="small">{t("已启用")}</Tag>
                : <Tag size="small">{t("未启用")}</Tag>}
            </div>
            <span>
              {accountWorkspace.status.data?.enabled
                ? t("已统一管理 {count} 个渠道账号；路由、启停和本机地址仍由各设备管理", { count: accountWorkspace.status.data.linkedAccounts })
                : t("端到端加密同步账号名称、账号 ID、API Key 与工作区默认地址")}
            </span>
            {!accountWorkspace.status.data?.enabled ? (
              <span className={styles.workspaceJoinHint}>
                {t("已有工作区？在「连接新设备 → 导入连接」粘贴接入包即可加入")}
              </span>
            ) : null}
          </div>
          <div className={styles.actions}>
            {accountWorkspace.status.data?.enabled ? <>
              <Button
                type="primary"
                theme="solid"
                loading={accountWorkspace.sync.isPending}
                onClick={() => void syncAccountWorkspace()}
              >
                {t("同步账号")}
              </Button>
            </> : <>
              <Button
                type="primary"
                theme="solid"
                disabled={!settings.data?.config}
                onClick={() => setWorkspaceConsentVisible(true)}
              >
                {t("启用账号工作区")}
              </Button>
            </>}
          </div>
        </div>
      </section>

      <section className={styles.card} data-keywords="局域网 LAN 直连 内网 同步">
        <header className={styles.sectionHeader}>
          <div>
            <div className={styles.deviceTitle}>
              <strong>{t("局域网直连")}</strong>
              {lanStatus.data?.status.running
                ? <Tag color="green" size="small">{t("运行中")}</Tag>
                : <Tag size="small">{t("未开启")}</Tag>}
            </div>
            <span>{t("同一局域网内的设备直接同步与操作，不经过云端")}</span>
          </div>
          <div className={styles.actions}>
            <Button
              theme="outline"
              loading={lanProbes.isFetching}
              onClick={() => void lanProbes.refetch()}
            >
              {t(lanProbes.isFetching ? "正在探测…" : "重新探测")}
            </Button>
          </div>
        </header>
        <div className={styles.lanBody}>
          <div className={styles.lanService}>
            <div>
              <span>{t("直连服务")}</span>
              {lanStatus.data?.status.running ? (
                <code>{lanStatus.data.status.endpoints.join(", ")}</code>
              ) : (
                <strong>{lanStatus.data?.status.error ?? t("未开启")}</strong>
              )}
            </div>
            {lanStatus.data?.status.running && lanStatus.data.status.startedAt ? (
              <div>
                <span>{t("启动时间")}</span>
                <strong>{formatFullTimestamp(lanStatus.data.status.startedAt, language)}</strong>
              </div>
            ) : null}
          </div>
          <LanPeerList devices={devices.data ?? []} probes={lanProbes.data} loading={lanProbes.isLoading} t={t} />
          <div className={styles.lanInbound}>
            <span>{t("最近入站连接")}</span>
            {(lanStatus.data?.inbound.length ?? 0) === 0 ? (
              <small>{t("暂无入站连接")}</small>
            ) : (
              <ul>
                {lanStatus.data!.inbound.slice(0, 8).map((event, index) => (
                  <li key={`${event.at}-${index}`}>
                    <code>{event.remoteAddr}</code>
                    <em>{lanPathLabel(event.path, t)}</em>
                    <time>{formatFullTimestamp(event.at, language)}</time>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </section>

      <section className={styles.card} data-keywords="设备 ID 导入 导出 多设备 用量">
        <header className={styles.sectionHeader}>
          <div>
            <strong>{t("设备与用量")}</strong>
            <span>{t("跨设备汇总每日 Token 用量，不同步费用、账号及请求明细")}</span>
          </div>
          <div className={styles.actions}>
            <Button theme="outline" onClick={openConnectionImport}>{t("导入用量")}</Button>
            <Dropdown
              position="bottomRight"
              trigger="click"
              clickToHide
              render={(
                <Dropdown.Menu>
                  <Dropdown.Item onClick={() => void chooseUsageImport()}>{t("从文件导入用量")}</Dropdown.Item>
                  <Dropdown.Item onClick={() => void exportUsage()}>{t("导出当前设备")}</Dropdown.Item>
                  <Dropdown.Item
                    disabled={devices.isFetching}
                    icon={<IconRefresh />}
                    onClick={() => void refreshDevices()}
                  >
                    {t(devices.isFetching ? "正在刷新设备列表…" : "刷新设备列表")}
                  </Dropdown.Item>
                </Dropdown.Menu>
              )}
            >
              <Button
                icon={<IconMore />}
                theme="outline"
                loading={devices.isFetching}
                aria-label={t("更多操作")}
              />
            </Dropdown>
            <Button
              icon={<IconPlus />}
              type="primary"
              theme="solid"
              disabled={!settings.data?.config}
              loading={transfer.exportS3ConnectionConfig.isPending}
              onClick={() => void openShare("qr")}
            >
              {t("连接新设备")}
            </Button>
          </div>
        </header>
        <div className={styles.deviceTable}>
          <div className={styles.deviceHead} aria-hidden="true">
            <span>{t("设备信息")}</span>
            <span>{t("使用情况")}</span>
            <span>{t("最后数据更新")}</span>
            <span>{t("状态")}</span>
            <span />
          </div>
          {(devices.data ?? []).map((device) => (
            <article className={styles.deviceRow} key={device.deviceId}>
              <div className={styles.deviceMain} title={device.deviceId}>
                <div className={styles.deviceGlyph}>{t(device.isCurrent ? "本" : "设")}</div>
                <div className={styles.deviceCopy}>
                  <strong>{device.displayName}</strong>
                  <span>
                    {platformLabel(device.platform)}
                    {device.appVersion !== "unknown" ? ` · Flowlet ${device.appVersion}` : ""}
                    {" · "}
                    {device.firstUsageDate && device.lastUsageDate ? `${device.firstUsageDate} — ${device.lastUsageDate}` : t("暂无用量")}
                  </span>
                </div>
              </div>
              <div className={styles.deviceStats}>
                <strong>{formatCompactNumber(device.knownTokens, language)}</strong>
                <span>{t("{count} 次请求", { count: device.requestCount })}</span>
              </div>
              <time className={styles.deviceUpdated} dateTime={device.lastSeenAt}>
                {formatFullTimestamp(device.lastSeenAt, language)}
              </time>
              <div className={styles.deviceState}>
                {device.isCurrent ? <Tag color="blue" size="small">{t("当前设备")}</Tag> : <Tag size="small">{t("已导入")}</Tag>}
              </div>
              <div className={styles.deviceMenu}>
                {device.isCurrent ? (
                  <Dropdown
                    position="bottomRight"
                    trigger="click"
                    clickToHide
                    render={(
                      <Dropdown.Menu>
                        <Dropdown.Item onClick={() => setRenameValue(device.displayName)}>{t("重命名")}</Dropdown.Item>
                        <Dropdown.Item onClick={() => void exportUsage()}>{t("导出用量")}</Dropdown.Item>
                      </Dropdown.Menu>
                    )}
                  >
                    <Button icon={<IconMore />} theme="borderless" aria-label={t("设备操作：{name}", { name: device.displayName })} />
                  </Dropdown>
                ) : null}
              </div>
            </article>
          ))}
          {devices.isLoading ? <div className={styles.state}>{t("正在读取设备信息…")}</div> : null}
          {devices.isError ? <div className={styles.state}>{t("设备信息加载失败")}</div> : null}
        </div>
      </section>

      <Modal
        title={(
          <div className={styles.connectionTitle}>
            <strong>{t("连接新设备")}</strong>
            <span>{t("选择一种方式，将手机或另一台桌面设备连接到当前同步空间")}</span>
          </div>
        )}
        visible={connectionTab != null}
        motion={false}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        width={748}
        bodyStyle={{ padding: 0 }}
        footer={null}
        onCancel={closeConnectionDialog}
      >
        <Tabs
          className={styles.connectionTabs}
          type="line"
          activeKey={connectionTab ?? "qr"}
          tabPaneMotion={false}
          onChange={(key) => {
            const next = key as ConnectionTab;
            if (next === "import") {
              setConnectionText((current) => current ?? "");
              setConnectionTab(next);
            } else {
              // 二维码固定使用普通连接包（面向移动端，不含工作区密钥）；
              // 连接文本按是否勾选工作区重新生成，切换页签时始终与当前选项一致。
              void generateShare(next, next === "text" && includeWorkspace);
            }
          }}
        >
          <Tabs.TabPane tab={t("扫码连接")} itemKey="qr">
            <div className={styles.qrLayout}>
              <div className={styles.qrPanel}>
                {sharePackage ? <QRCodeSVG value={sharePackage.qr} size={214} level="M" marginSize={1} /> : null}
                <span>{t("使用 Flowlet 移动端扫描")}</span>
              </div>
              <div className={styles.connectGuide}>
                <h3>{t("在另一台设备上完成连接")}</h3>
                <ol>
                  <li><span>1</span><p>{t("打开 Flowlet 移动端，进入「设置 → 同步管理」。")}</p></li>
                  <li><span>2</span><p>{t("点击「扫码连接」，扫描左侧二维码。")}</p></li>
                  <li><span>3</span><p>{t("确认设备名称后，即可开始同步每日用量。")}</p></li>
                </ol>
                {workspaceEnabled ? (
                  <p className={styles.qrWorkspaceHint}>
                    {t("二维码面向移动端，不包含账号工作区密钥；桌面设备请使用「连接文本」并勾选工作区")}
                  </p>
                ) : null}
                <div className={styles.expireBox}>
                  <span>{t("连接信息将在 {seconds} 秒后失效", { seconds: expiresIn })}</span>
                  <Button icon={<IconRefresh />} theme="outline" loading={transfer.exportS3ConnectionConfig.isPending} onClick={() => void openShare("qr")}>{t("刷新二维码")}</Button>
                </div>
              </div>
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("连接文本")} itemKey="text">
            <div className={styles.connectionPanel}>
              {workspaceEnabled ? (
                <div className={styles.workspaceOption}>
                  <Checkbox
                    checked={includeWorkspace}
                    onChange={(event) => toggleIncludeWorkspace(event.target.checked ?? false)}
                  >
                    {t("包含渠道账号工作区")}
                  </Checkbox>
                  <span>{t("勾选后连接文本附带工作区解密密钥，仅用于可信的桌面设备")}</span>
                </div>
              ) : null}
              <p className={styles.secretNotice}>{t("连接文本包含访问凭证，仅用于你信任的设备。界面默认隐藏 Secret，复制时会复制完整内容。")}</p>
              <pre className={styles.connectionCode}>{sharePackage ? maskConnectionPackage(sharePackage.text) : ""}</pre>
              <div className={styles.connectionFoot}>
                <span>{t("该连接文本将在本弹窗关闭后失效")}</span>
                <Button icon={<IconCopy />} type="primary" theme="solid" onClick={() => void copyConnectionText()}>{t("复制连接文本")}</Button>
              </div>
            </div>
          </Tabs.TabPane>
          <Tabs.TabPane tab={t("导入连接")} itemKey="import">
            <div className={styles.importPanel}>
              <strong>{t("粘贴另一台设备生成的连接文本")}</strong>
              <TextArea
                autoFocus
                value={connectionText ?? ""}
                placeholder={t("粘贴 Flowlet 连接文本（连接包或账号工作区接入包）")}
                autosize={{ minRows: 10, maxRows: 10 }}
                onChange={setConnectionText}
              />
              {parsedPackage ? <div className={styles.importResult}>
                {parsedPackage.result ? (
                  parsedPackage.result.kind === "workspace" ? <>
                    <Tag color="blue" size="small">{t("账号工作区接入包")}</Tag>
                    <strong>{parsedPackage.result.package.s3.bucket}</strong>
                    <span>{parsedPackage.result.package.s3.endpoint} · {parsedPackage.result.package.s3.prefix || "flowlet/"}</span>
                  </> : <>
                    <strong>{parsedPackage.result.config.bucket}</strong>
                    <span>{parsedPackage.result.config.endpoint} · {parsedPackage.result.config.prefix || "flowlet/"}</span>
                  </>
                ) : <span className={styles.importError}>{parsedPackage.error}</span>}
              </div> : null}
              <div className={styles.connectionFoot}>
                <span>
                  {parsedPackage?.result?.kind === "workspace"
                    ? t("导入后将同时配置 S3 同步并加入渠道账号工作区")
                    : t("导入后仅共享设备身份与每日 Token 汇总")}
                </span>
                <Button
                  type="primary"
                  theme="solid"
                  disabled={!parsedPackage?.result}
                  loading={transfer.testS3Connection.isPending || transfer.saveS3Config.isPending || accountWorkspace.importDesktopPackage.isPending}
                  onClick={() => void importConnection()}
                >
                  {parsedPackage?.result?.kind === "workspace" ? t("校验并加入") : t("校验并导入")}
                </Button>
              </div>
            </div>
          </Tabs.TabPane>
        </Tabs>
      </Modal>

      <Modal
        title={t("启用渠道账号工作区")}
        visible={workspaceConsentVisible}
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => setWorkspaceConsentVisible(false)}
        onOk={() => void initializeAccountWorkspace()}
        okButtonProps={{ loading: accountWorkspace.initialize.isPending }}
        okText={t("加密并启用")}
        cancelText={t("取消")}
      >
        <div className={styles.workspaceConsent}>
          <p>{t("现有渠道账号将使用独立密钥加密后写入已配置的 S3。加入工作区的桌面设备可读取账号凭据，但移动端连接包不会包含此密钥。")}</p>
          <p>{t("启用后，账号名称、API Key 和工作区默认地址由 S3 统一管理；路由、启停、优先级、模型选择和本机地址仍只保存在当前设备。")}</p>
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
    width="min(760px, 96vw)"
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

function maskConnectionPackage(value: string) {
  try {
    const data = JSON.parse(value) as {
      config?: { accessKeyId?: string; secretAccessKey?: string };
      s3?: { accessKeyId?: string; secretAccessKey?: string };
      accountWorkspaceKey?: string;
    };
    // 普通连接包的凭据在 config，账号工作区接入包在 s3；两种包都要隐藏密钥。
    const secrets = data.config ?? data.s3;
    if (secrets?.accessKeyId) {
      secrets.accessKeyId = `${secrets.accessKeyId.slice(0, 12)}••••••`;
    }
    if (secrets?.secretAccessKey) {
      secrets.secretAccessKey = "••••••••••••••••••••••••••••";
    }
    if (data.accountWorkspaceKey) {
      data.accountWorkspaceKey = "••••••••••••••••••••••••••••";
    }
    return JSON.stringify(data, null, 2);
  } catch {
    return value;
  }
}

function SyncStatusTag({ status }: { status: string }) {
  const { t } = useAppPreferences();
  if (status === "success") return <Tag color="green" size="small">{t("已同步")}</Tag>;
  if (status === "partial") return <Tag color="orange" size="small">{t("部分成功")}</Tag>;
  if (status === "failed") return <Tag color="red" size="small">{t("失败")}</Tag>;
  if (status === "running") return <Tag color="blue" size="small">{t("同步中")}</Tag>;
  return <Tag size="small">{t("未同步")}</Tag>;
}

function LanPeerList({
  devices,
  probes,
  loading,
  t,
}: {
  devices: Array<{ deviceId: string; displayName: string; isCurrent: boolean }>;
  probes: Array<{
    deviceId: string;
    lanPublished: boolean;
    reachable: boolean;
    latencyMs: number | null;
    errorKind: string | null;
    error: string | null;
  }> | undefined;
  loading: boolean;
  t: Translate;
}) {
  if (loading) {
    return <div className={styles.lanPeers}><span className={styles.lanHint}>{t("正在探测…")}</span></div>;
  }
  const rows = (probes ?? []).map((probe) => {
    const device = devices.find((item) => item.deviceId === probe.deviceId);
    return { probe, name: device?.displayName ?? probe.deviceId.slice(0, 8) };
  });
  if (rows.length === 0) {
    return (
      <div className={styles.lanPeers}>
        <span className={styles.lanHint}>{t("尚未发现局域网设备。设备会通过云端同步自动发布直连信息。")}</span>
      </div>
    );
  }
  return (
    <div className={styles.lanPeers}>
      {rows.map(({ probe, name }) => (
        <div className={styles.lanPeer} key={probe.deviceId}>
          <strong>{name}</strong>
          {!probe.lanPublished ? (
            <span className={styles.lanState} data-state="muted">{t("未发布直连信息")}</span>
          ) : probe.reachable ? (
            <span className={styles.lanState} data-state="ok">
              {probe.latencyMs != null
                ? t("可直连 · {ms}ms", { ms: probe.latencyMs })
                : t("可直连")}
            </span>
          ) : (
            <span className={styles.lanState} data-state="fail" title={probe.error ?? undefined}>
              {probe.errorKind === "unauthorized"
                ? t("局域网认证失败，等待下一次同步刷新连接信息")
                : probe.errorKind === "outdated"
                  ? t("对端版本过旧，无法探测")
                  : t("不可直连")}
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function lanPathLabel(path: string, t: Translate) {
  if (path === "/flowlet/v1/ping") return t("探测");
  if (path === "/flowlet/v1/snapshot") return t("读取快照");
  if (path.includes("/reply")) return t("回复权限");
  if (path.includes("/permissions/")) return t("查询权限");
  return path;
}
