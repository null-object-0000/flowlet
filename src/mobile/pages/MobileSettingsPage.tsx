import { IconRefresh } from "@douyinfe/semi-icons";
import { onBackButtonPress } from "@tauri-apps/api/app";
import { cancel, Format, checkPermissions, openAppSettings, requestPermissions, scan } from "@tauri-apps/plugin-barcode-scanner";
import { Button, Input, Select, SideSheet, Switch, TextArea, Toast } from "@douyinfe/semi-ui-19";
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import packageJson from "../../../package.json";
import type { AppLanguage } from "../../app/preferences/translations";
import { useAppPreferences, type ThemePreference } from "../../app/preferences/AppPreferences";
import { parseS3ConnectionPackage } from "../../domains/device-sync/s3ConnectionPackage";
import type { S3SyncConfigInput } from "../../domains/device-sync/types";
import { useMobileDeviceSyncActions, useMobileS3Settings } from "../../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../../shared/errors/AppError";
import { formatFullTimestamp } from "../../shared/formatters/datetime";
import type { TokenUnit } from "../../shared/formatters/number";
import { FlowletLogo } from "../../shared/ui/FlowletLogo";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { MobileCardView, MobilePageHeaderView, MobilePageView, mobilePageStyles as styles } from "@flowlet/product-ui";

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
  const { language, setLanguage, theme, setTheme, tokenUnit, setTokenUnit, t } = useAppPreferences();
  const settings = useMobileS3Settings();
  const actions = useMobileDeviceSyncActions();
  const [draft, setDraft] = useState<S3SyncConfigInput>(emptyConfig);
  const [connectionText, setConnectionText] = useState<string | null>(null);
  const [manualConfigOpen, setManualConfigOpen] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const scannerActive = useRef(false);
  const scannerSession = useRef(0);
  const scannerBackButtonListener = useRef<Awaited<ReturnType<typeof onBackButtonPress>> | null>(null);
  const parsedConnection = useMemo(() => {
    if (connectionText == null || !connectionText.trim()) return null;
    try {
      return { config: parseS3ConnectionPackage(connectionText), error: null };
    } catch (error) {
      return { config: null, error: errorMessage(error) };
    }
  }, [connectionText]);

  useEffect(() => {
    if (!settings.data?.config) return;
    setDraft({ ...settings.data.config, secretAccessKey: null });
  }, [settings.data?.config]);

  useEffect(() => () => {
    scannerSession.current += 1;
    const shouldCancelNativeScanner = scannerActive.current;
    scannerActive.current = false;
    clearScannerPresentation();
    void scannerBackButtonListener.current?.unregister().catch(() => undefined);
    scannerBackButtonListener.current = null;
    if (shouldCancelNativeScanner) void cancel().catch(() => undefined);
  }, []);

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
  const refresh = async () => {
    setRefreshError(null);
    try {
      await actions.refreshS3.mutateAsync();
    } catch (error) {
      setRefreshError(errorMessage(error));
    }
  };
  const scanConnection = async () => {
    if (scannerActive.current) return;
    const session = scannerSession.current + 1;
    scannerSession.current = session;
    let backButtonListener: Awaited<ReturnType<typeof onBackButtonPress>> | null = null;
    try {
      let permission = await checkPermissions();
      if (permission === "prompt") {
        permission = await requestPermissions();
      }
      if (permission !== "granted") {
        Toast.error(t("需要相机权限才能扫描连接二维码"));
        await openAppSettings();
        return;
      }
      scannerActive.current = true;
      prepareScannerPresentation();
      setScanning(true);
      if (import.meta.env.TAURI_ENV_PLATFORM === "android") {
        backButtonListener = await onBackButtonPress(() => {
          cancelScanning();
        });
        if (session !== scannerSession.current) {
          await backButtonListener.unregister().catch(() => undefined);
          return;
        }
        scannerBackButtonListener.current = backButtonListener;
      }
      await waitForScannerOverlay();
      if (session !== scannerSession.current) return;
      const result = await scan({
        cameraDirection: "back",
        formats: [Format.QRCode],
        windowed: true,
      });
      if (session === scannerSession.current) {
        setConnectionText(result.content);
      }
    } catch (error) {
      if (session === scannerSession.current && !isScannerCancellation(error)) {
        Toast.error(t("扫描二维码失败：{message}", { message: errorMessage(error) }));
      }
    } finally {
      await backButtonListener?.unregister().catch(() => undefined);
      if (scannerBackButtonListener.current === backButtonListener) {
        scannerBackButtonListener.current = null;
      }
      if (session === scannerSession.current) {
        finishScannerPresentation();
      }
    }
  };
  const finishScannerPresentation = () => {
    scannerSession.current += 1;
    scannerActive.current = false;
    clearScannerPresentation();
    setScanning(false);
    const listener = scannerBackButtonListener.current;
    scannerBackButtonListener.current = null;
    void listener?.unregister().catch(() => undefined);
  };
  const cancelScanning = () => {
    const shouldCancelNativeScanner = scannerActive.current;
    finishScannerPresentation();
    if (shouldCancelNativeScanner) {
      void cancel().catch((error) => {
        console.warn("Failed to cancel barcode scanner", error);
      });
    }
  };
  const importConnection = async () => {
    const config = parsedConnection?.config;
    if (!config) return;
    try {
      await actions.testS3Connection.mutateAsync(config);
      await actions.saveS3Config.mutateAsync(config);
      setDraft(config);
      setConnectionText(null);
      Toast.success(t("S3 连接配置已导入"));
    } catch (error) {
      Toast.error(t("导入连接配置失败：{message}", { message: errorMessage(error) }));
      return;
    }

    setRefreshError(null);
    try {
      await actions.refreshS3.mutateAsync();
    } catch (error) {
      const message = errorMessage(error);
      setRefreshError(message);
      Toast.warning(t("自动刷新失败：{message}", { message }));
    }
  };
  const syncStatus = settings.data?.status;
  const syncStatusState = refreshError
    ? "failed"
    : actions.refreshS3.isPending
      ? "running"
      : syncStatus?.status ?? "never";
  const syncStatusText = refreshError
    ? t("刷新失败：{message}", { message: refreshError })
    : actions.refreshS3.isPending
      ? t("正在刷新远端数据…")
      : syncStatus?.message ?? t("正在读取设置…");

  return (
    <MobilePageView>
      <MobilePageHeaderView title={t("设置")} subtitle={t("管理外观、连接方式和应用信息")} />

      <MobileCardView>
        <div className={styles.cardHeader}><div><strong>{t("快速连接")}</strong><span>{t("扫描桌面端二维码，或粘贴完整连接文本")}</span></div></div>
        <div className={styles.actions}>
          <Button type="primary" theme="solid" loading={scanning} onClick={() => void scanConnection()}>{t("扫描二维码")}</Button>
          <Button onClick={() => setConnectionText("")}>{t("粘贴连接文本")}</Button>
        </div>
      </MobileCardView>

      <MobileCardView>
        <div className={styles.cardHeader}>
          <div><strong>{t("同步状态")}</strong><span>{t("从云端刷新设备、用量和会话摘要")}</span></div>
          <Button
            theme="borderless"
            icon={<IconRefresh />}
            loading={actions.refreshS3.isPending}
            disabled={!settings.data?.config}
            onClick={() => void refresh()}
          >
            {t("刷新")}
          </Button>
        </div>
        <div className={styles.syncStrip}>
          <div className={styles.status} data-state={syncStatusState}><i /><span>{syncStatusText}</span></div>
          <time>{syncStatus?.lastSuccessAt ? formatFullTimestamp(syncStatus.lastSuccessAt, language) : t("尚未成功刷新")}</time>
        </div>
        {syncStatus?.failureDetails?.length ? (
          <div className={styles.syncFailureDetails}>
            <strong>{t("失败详情")}</strong>
            {syncStatus.failureDetails.map((detail, index) => (
              <span key={`${index}-${detail}`}>{detail}</span>
            ))}
          </div>
        ) : null}
      </MobileCardView>

      <MobileCardView>
        <div className={styles.cardHeader}><div><strong>{t("外观")}</strong><span>{t("语言、主题和 Token 展示单位修改后立即生效")}</span></div></div>
        <div className={styles.preferenceRows}>
          <label><span>{t("显示语言")}</span><Select value={language} optionList={[{ value: "zh-CN", label: t("简体中文") }, { value: "en-US", label: "English" }]} onChange={(value) => setLanguage(value as AppLanguage)} /></label>
          <label><span>{t("界面主题")}</span><Select value={theme} optionList={[{ value: "system", label: t("跟随系统") }, { value: "light", label: t("浅色模式") }, { value: "dark", label: t("深色模式") }]} onChange={(value) => setTheme(value as ThemePreference)} /></label>
          <label><span>{t("Token 展示单位")}</span><Select value={tokenUnit} optionList={[{ value: "auto", label: t("跟随语言") }, { value: "zh", label: t("万 / 亿（中文习惯）") }, { value: "en", label: t("K / M（英文习惯）") }]} onChange={(value) => setTokenUnit(value as TokenUnit)} /></label>
        </div>
      </MobileCardView>

      <MobileCardView>
        <div className={styles.collapsibleHeader}>
          <div><strong>{t("手动配置 S3")}</strong><span>{settings.data?.config ? t("已配置，可在需要时展开修改") : t("仅在无法扫码或粘贴连接文本时使用")}</span></div>
          <Button theme="borderless" onClick={() => setManualConfigOpen((open) => !open)}>{manualConfigOpen ? t("收起") : t("展开")}</Button>
        </div>
        {manualConfigOpen ? (
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
        ) : null}
      </MobileCardView>

      <MobileCardView className={styles.aboutCard}>
        <FlowletLogo variant="brand" />
        <div><strong>Flowlet</strong><span>{t("移动数据查看器")}</span><small>v{packageJson.version}</small></div>
      </MobileCardView>

      <SideSheet
        title={t("导入 S3 连接")}
        visible={connectionText != null}
        placement="right"
        width="100%"
        zIndex={APP_OVERLAY_Z_INDEX.modal}
        onCancel={() => setConnectionText(null)}
        headerStyle={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 14px)" }}
        bodyStyle={{ padding: "16px 16px calc(env(safe-area-inset-bottom, 0px) + 92px)" }}
        footer={(
          <div className={styles.importFooter}>
            <Button onClick={() => setConnectionText(null)}>{t("取消")}</Button>
            <Button
              theme="solid"
              type="primary"
              disabled={!parsedConnection?.config}
              loading={actions.testS3Connection.isPending || actions.saveS3Config.isPending}
              onClick={() => void importConnection()}
            >
              {t("测试并保存")}
            </Button>
          </div>
        )}
      >
        <div className={styles.form}>
          <div className={styles.permissions}><strong>{t("安全提示")}</strong><span>{t("连接包包含 S3 访问凭据，只导入来自可信桌面设备的内容。")}</span></div>
          <TextArea
            autoFocus={connectionText === ""}
            value={connectionText ?? ""}
            placeholder={t("粘贴 Flowlet S3 连接包 JSON")}
            autosize={{ minRows: 9, maxRows: 9 }}
            onChange={setConnectionText}
          />
          {parsedConnection ? <div className={styles.permissions}>
            {parsedConnection.config
              ? <><strong>{parsedConnection.config.bucket}</strong><span>{parsedConnection.config.endpoint} · {parsedConnection.config.prefix || "flowlet/"}</span></>
              : <><strong>{t("无法识别连接包")}</strong><span>{parsedConnection.error}</span></>}
          </div> : null}
        </div>
      </SideSheet>

      {scanning ? createPortal(
        <div className={styles.scannerOverlay} role="dialog" aria-label={t("扫描连接二维码")}>
          <div className={styles.scannerTop}>
            <strong>{t("扫描连接二维码")}</strong>
            <Button theme="solid" onClick={() => void cancelScanning()}>{t("取消")}</Button>
          </div>
          <div className={styles.scannerFrame} aria-hidden="true" />
          <p>{t("将桌面端生成的二维码放入框内")}</p>
        </div>,
        document.body,
      ) : null}
    </MobilePageView>
  );
}

function isScannerCancellation(error: unknown) {
  return errorMessage(error).trim().toLowerCase() === "cancelled";
}

function prepareScannerPresentation() {
  document.body.dataset.flowletScanning = "true";
}

function clearScannerPresentation() {
  delete document.body.dataset.flowletScanning;
}

function waitForScannerOverlay() {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}
