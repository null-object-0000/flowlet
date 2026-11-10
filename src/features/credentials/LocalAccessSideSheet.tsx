import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner, Button, Modal, SideSheet, Tag, Toast, Typography } from "@douyinfe/semi-ui-19";
import { IconCopy, IconDelete, IconRefresh } from "@douyinfe/semi-icons";
import { useAppPreferences } from "../../app/preferences/AppPreferences";
import { APP_OVERLAY_Z_INDEX } from "../../shared/ui/overlayLayers";
import { DETAIL_SHEET_WIDTH } from "../../shared/ui/drawerWidth";
import { errorMessage } from "../../shared/errors/AppError";
import { copyText } from "../../shared/ui/copyText";
import { formatTimestamp } from "../../shared/formatters/datetime";
import {
  agentPrompt,
  downloadsUrl,
  fetchLocalAccessManifest,
  formatBytes,
  installCommand,
  localAccessManifestQueryKey,
  localAccessUrls,
  loginCommand,
  pullCommand,
  type LocalAccessArtifact,
} from "../../domains/credentials/localAccess";
import { credentialCommands } from "../../domains/credentials/commands";
import { envKeysForPrefix, providerDefaultEnvPrefix, resolveEnvPrefix } from "../../domains/credentials/envPrefix";
import type {
  CliAuthToken,
  CredentialProvider,
  ServiceCredential,
} from "../../domains/credentials/types";
import { queryKeys } from "../../shared/query-keys";
import styles from "./LocalAccessSideSheet.module.css";

const { Text, Title } = Typography;

/** 产物短 sha256，便于人工核对。 */
function shortSha256(sha256: string): string {
  return sha256.length > 16 ? `${sha256.slice(0, 16)}…` : sha256;
}

type Props = {
  visible: boolean;
  onClose: () => void;
  /** 已加载的服务凭据（本机环境变量预览用；空列表显示引导）。 */
  credentials: ServiceCredential[];
  /** provider 元数据：`defaultEnvPrefix` 兜底。 */
  providers: CredentialProvider[];
  credentialsLoading?: boolean;
};

/**
 * 「本机接入」引导抽屉（仅 Web Host 渲染入口）。
 *
 * 内容：安装 CLI / 登录授权 + 同步凭据 / 已授权的 CLI / 安装 Skills（含复制 Agent 提示词）/
 * 本机环境变量预览 / 下载产物版本与 sha256。manifest 读取失败、CLI 授权列表不可用
 * （桌面 Host 尚未实现该命令）都不阻塞其它内容，只给出兜底文案。
 */
export function LocalAccessSideSheet({
  visible,
  onClose,
  credentials,
  providers,
  credentialsLoading = false,
}: Props) {
  const { language, t } = useAppPreferences();
  const queryClient = useQueryClient();
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const origin = window.location.origin;
  const base = downloadsUrl();
  const urls = localAccessUrls();
  const manifest = useQuery({
    queryKey: localAccessManifestQueryKey,
    queryFn: fetchLocalAccessManifest,
    enabled: visible,
    retry: false,
    staleTime: 60_000,
  });

  /** 已授权的 CLI：旧 Host / 桌面 Host 没有这些命令，查询失败时只降级展示文案。 */
  const cliTokens = useQuery({
    queryKey: queryKeys.credentials.cliAuthTokens(),
    queryFn: credentialCommands.listCliAuthTokens,
    enabled: visible,
    retry: false,
    staleTime: 30_000,
  });

  const copy = async (value: string, message: string) => {
    try {
      await copyText(value);
      Toast.success(message);
    } catch (error) {
      Toast.error(t("复制失败：{message}", { message: errorMessage(error) }));
    }
  };

  const revokeToken = async (token: CliAuthToken) => {
    setRevokingId(token.id);
    try {
      await credentialCommands.revokeCliAuthToken(token.id);
      Toast.success(t("已撤销 CLI 授权"));
      await queryClient.invalidateQueries({ queryKey: queryKeys.credentials.cliAuthTokens() });
    } catch (error) {
      Toast.error(t("撤销失败：{message}", { message: errorMessage(error) }));
    } finally {
      setRevokingId(null);
    }
  };

  const confirmRevoke = (token: CliAuthToken) => {
    Modal.confirm({
      title: t("撤销 CLI 授权"),
      content: t("撤销后，该机器上的 flowlet pull 会返回 401，需要重新执行 flowlet login。"),
      okText: t("撤销"),
      cancelText: t("取消"),
      zIndex: APP_OVERLAY_Z_INDEX.modal,
      onOk: () => revokeToken(token),
    });
  };

  const providerLabel = (id: string) =>
    providers.find((provider) => provider.id === id)?.label ?? id;

  const defaultPrefixFor = (id: string) => {
    const provider = providers.find((item) => item.id === id);
    return provider ? providerDefaultEnvPrefix(provider) : id.toUpperCase();
  };

  const enabledCredentials = credentials.filter((credential) => credential.enabled);
  const tokens = cliTokens.data ?? [];

  return (
    <SideSheet
      visible={visible}
      title={t("本机接入")}
      width={DETAIL_SHEET_WIDTH}
      zIndex={APP_OVERLAY_Z_INDEX.sideSheet}
      bodyStyle={{ padding: 0 }}
      footer={null}
      onCancel={onClose}
    >
      <div className={styles.body}>
        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("安装 CLI")}</Title>
              <Text type="tertiary" size="small">
                {t("在本机（Agent 所在机器）安装 flowlet 命令，需要 Node.js 22.6+。")}
              </Text>
            </div>
            <Button
              size="small"
              icon={<IconCopy />}
              onClick={() => void copy(installCommand(base), t("安装命令已复制"))}
            >
              {t("复制命令")}
            </Button>
          </div>
          <div className={styles.codeBlock}>
            <code>{installCommand(base)}</code>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("登录并同步凭据")}</Title>
              <Text type="tertiary" size="small">
                {t("两步完成：先在浏览器登录 Flowlet 管理台并授权本机 CLI，再同步启用中的服务凭据。本页不会收集管理凭据。")}
              </Text>
            </div>
          </div>
          <div className={styles.stepList}>
            <div className={styles.step}>
              <div className={styles.stepHeader}>
                <div className={styles.stepTitle}>
                  <Tag color="blue" type="light">
                    1
                  </Tag>
                  <Text strong>{t("登录授权")}</Text>
                </div>
                <Button
                  size="small"
                  icon={<IconCopy />}
                  onClick={() => void copy(loginCommand(origin), t("登录命令已复制"))}
                >
                  {t("复制命令")}
                </Button>
              </div>
              <Text type="tertiary" size="small">
                {t("打开浏览器完成管理台登录授权（使用该实例配置的登录方式，如企业 SSO）；CLI 会拿到一把只能读取服务凭据的 token（30 天有效，可随时在下方撤销）。")}
              </Text>
              <div className={styles.codeBlock}>
                <code>{loginCommand(origin)}</code>
              </div>
            </div>
            <div className={styles.step}>
              <div className={styles.stepHeader}>
                <div className={styles.stepTitle}>
                  <Tag color="blue" type="light">
                    2
                  </Tag>
                  <Text strong>{t("同步凭据")}</Text>
                </div>
                <Button
                  size="small"
                  icon={<IconCopy />}
                  onClick={() => void copy(pullCommand(origin), t("同步命令已复制"))}
                >
                  {t("复制命令")}
                </Button>
              </div>
              <Text type="tertiary" size="small">
                {t("可重复执行，只同步启用中的服务凭据；已登录时无需再填任何管理凭据。")}
              </Text>
              <div className={styles.codeBlock}>
                <code>{pullCommand(origin)}</code>
              </div>
            </div>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("已授权的 CLI")}</Title>
              <Text type="tertiary" size="small">
                {t("这些授权来自 flowlet login，只能读取服务凭据；撤销后对应机器需要重新登录。")}
              </Text>
            </div>
            <Button
              size="small"
              icon={<IconRefresh />}
              loading={cliTokens.isFetching}
              onClick={() => void cliTokens.refetch()}
            >
              {t("刷新")}
            </Button>
          </div>
          {cliTokens.isLoading ? (
            <Text type="tertiary" size="small">
              {t("正在读取 CLI 授权…")}
            </Text>
          ) : cliTokens.error ? (
            <Banner
              type="warning"
              closeIcon={null}
              description={t(
                "当前 Flowlet Host 暂不支持查看 CLI 授权列表；上面的登录与同步命令仍可使用，撤销请等服务端升级。",
              )}
            />
          ) : tokens.length === 0 ? (
            <Text type="tertiary" size="small">
              {t("暂无 CLI 授权")}
            </Text>
          ) : (
            <div className={styles.tokenList}>
              {tokens.map((token) => (
                <div className={styles.tokenRow} key={token.id}>
                  <div className={styles.tokenMain}>
                    <Text strong>{token.name.trim() ? token.name : t("未命名")}</Text>
                    <div className={styles.tokenMeta}>
                      <Text type="tertiary" size="small">
                        {t("创建时间：{time}", { time: formatTimestamp(token.createdAt, language) })}
                      </Text>
                      <Text type="tertiary" size="small">
                        {t("到期时间：{time}", { time: formatTimestamp(token.expiresAt, language) })}
                      </Text>
                      <Text type="tertiary" size="small">
                        {token.lastUsedAt
                          ? t("最近使用：{time}", { time: formatTimestamp(token.lastUsedAt, language) })
                          : t("从未使用")}
                      </Text>
                    </div>
                  </div>
                  <Button
                    size="small"
                    type="danger"
                    icon={<IconDelete />}
                    loading={revokingId === token.id}
                    onClick={() => confirmRevoke(token)}
                  >
                    {t("撤销")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("安装 Skills")}</Title>
              <Text type="tertiary" size="small">
                {t("下载 Skills 包后解压到你所用 Agent 的 skills 目录；本页不预设各客户端路径。")}
              </Text>
            </div>
            <Button
              size="small"
              icon={<IconCopy />}
              onClick={() => void copy(agentPrompt(origin), t("Agent 提示词已复制"))}
            >
              {t("复制 Agent 提示词")}
            </Button>
          </div>
          <div className={styles.downloadRow}>
            <a className={styles.downloadLink} href={urls.skills} download>
              {t("下载 flowlet-skills.tar.gz")}
            </a>
            <Text type="tertiary" size="small">
              {t("包内为 flowlet-skills/flowlet-credentials/SKILL.md 与 README.md")}
            </Text>
          </div>
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("本机环境变量预览")}</Title>
              <Text type="tertiary" size="small">
                {t("同一个服务的多实例必须使用不同环境前缀，否则会生成相同的环境变量名。")}
              </Text>
            </div>
          </div>
          {credentialsLoading ? (
            <Text type="tertiary" size="small">
              {t("正在读取凭据…")}
            </Text>
          ) : enabledCredentials.length === 0 ? (
            <Text type="tertiary" size="small">
              {t("暂无已启用的服务凭据；添加并启用后会在这里显示对应的环境变量名。")}
            </Text>
          ) : (
            <div className={styles.envList}>
              {enabledCredentials.map((credential) => {
                const prefix = resolveEnvPrefix(credential.envPrefix, defaultPrefixFor(credential.provider));
                const keys = envKeysForPrefix(prefix);
                return (
                  <div className={styles.envCard} key={credential.id}>
                    <div className={styles.envHead}>
                      <Text strong>{credential.name}</Text>
                      <Tag color="blue" type="light">
                        {providerLabel(credential.provider)}
                      </Tag>
                      <Text type="tertiary" size="small">
                        {t("前缀：{prefix}", { prefix })}
                      </Text>
                    </div>
                    <div className={styles.envKeys}>
                      <code>{keys.url}</code>
                      <code>{keys.token}</code>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>

        <section className={styles.section}>
          <div className={styles.sectionHeader}>
            <div>
              <Title heading={5}>{t("下载产物")}</Title>
              <Text type="tertiary" size="small">
                {t("产物由当前 Flowlet 构建生成，随镜像一起发布。")}
              </Text>
            </div>
            <Button
              size="small"
              icon={<IconRefresh />}
              loading={manifest.isFetching}
              onClick={() => void manifest.refetch()}
            >
              {t("刷新")}
            </Button>
          </div>
          {manifest.isLoading ? (
            <Text type="tertiary" size="small">
              {t("正在读取下载信息…")}
            </Text>
          ) : manifest.error ? (
            <Banner
              type="warning"
              closeIcon={null}
              description={t("无法读取下载信息：{message}。上面的安装与同步命令仍可直接使用。", {
                message: errorMessage(manifest.error),
              })}
            />
          ) : manifest.data ? (
            <div className={styles.versionBlock}>
              <div className={styles.versionRow}>
                <Text type="tertiary" size="small">
                  {t("CLI 版本")}
                </Text>
                <Text strong>{manifest.data.version}</Text>
                {manifest.data.generatedAt && (
                  <Text type="tertiary" size="small">
                    {t("生成时间：{time}", {
                      time: formatTimestamp(manifest.data.generatedAt, language),
                    })}
                  </Text>
                )}
              </div>
              <div className={styles.artifactList}>
                {manifest.data.artifacts.map((artifact: LocalAccessArtifact) => (
                  <div className={styles.artifactRow} key={artifact.path}>
                    <code>{artifact.path}</code>
                    <Text type="tertiary" size="small">
                      {formatBytes(artifact.bytes)}
                    </Text>
                    <Text type="tertiary" size="small">
                      sha256 {shortSha256(artifact.sha256)}
                    </Text>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
        </section>
      </div>
    </SideSheet>
  );
}