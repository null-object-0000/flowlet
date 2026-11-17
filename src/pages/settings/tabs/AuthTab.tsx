import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Input, Switch, Toast, Typography } from "@douyinfe/semi-ui-19";
import { SettingRow, SettingSection } from "../SettingRow";
import { errorMessage } from "../../../shared/errors/AppError";
import {
  checkGithubAuthProvider,
  deleteGithubAuthProvider,
  getGithubAuthProvider,
  saveGithubAuthProvider,
  type GithubProviderSummary,
} from "../../../domains/settings/authProviders";
import {
  getAdminLoginMode,
  saveAdminLoginMode,
  type LoginProviderId,
} from "../../../domains/settings/oidcAuthProvider";
import { OidcAuthSection } from "./OidcAuthSection";

type Draft = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
};

const EMPTY_DRAFT: Draft = {
  enabled: false,
  clientId: "",
  clientSecret: "",
};

/** 登录提供器只负责认证连接；准入与角色在用户管理中配置。 */
export function AuthTab() {
  const [summary, setSummary] = useState<GithubProviderSummary | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "check" | "delete" | null>(null);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [next, mode] = await Promise.all([getGithubAuthProvider(), getAdminLoginMode()]);
      setSummary(next);
      setDraft({
        enabled: mode.enabled.includes("github"),
        clientId: next.client_id,
        clientSecret: "",

      });
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const payload = useMemo(() => {
    return {
      client_id: draft.clientId.trim(),
      client_secret: draft.clientSecret,
    };
  }, [draft]);

  const onCheck = async () => {
    setBusy("check");
    setCheckResult(null);
    try {
      const result = await checkGithubAuthProvider(payload);
      setCheckResult(result);
      if (result.ok) Toast.success(result.message);
      else Toast.error(result.message);
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  /**
   * 只改 GitHub 这一个开关：另一个提供方的状态**现取现用**，不能拿组件挂载时的快照，
   * 否则在 OIDC 段改过开关后再保存 GitHub 会把 OIDC 改回旧值。
   */
  const commitGithubEnabled = async (enabled: boolean) => {
    const current = await getAdminLoginMode();
    const others = current.enabled.filter((id): id is LoginProviderId => id !== "github");
    await saveAdminLoginMode([...others, ...(enabled ? (["github"] as LoginProviderId[]) : [])]);
  };

  const onSave = async () => {
    setBusy("save");
    try {
      await saveGithubAuthProvider(payload);
      await commitGithubEnabled(draft.enabled);
      Toast.success("已保存，立刻生效");
      await reload();
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    setBusy("delete");
    try {
      await deleteGithubAuthProvider();
      Toast.success("已关闭 GitHub 登录");
      setCheckResult(null);
      await reload();
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const githubStatus = loading
    ? "读取中…"
    : summary?.configured
      ? draft.enabled
        ? "已启用"
        : "已配置，未启用"
      : "尚未配置";

  return (
    <>
      <OidcAuthSection onSaved={() => void reload()} />
      <SettingSection
        title="GitHub 登录"
        note={`${githubStatus} · 登录准入与管理员角色统一在「用户管理」设置。`}
        keywords="github oauth 登录 单点登录 sso 认证 角色 只读"
      >
        <SettingRow
          name="在登录页启用 GitHub 登录"
          help="关掉只是不再提供这个入口，已登录的会话不受影响。"
          control={
            <Switch
              aria-label="在登录页启用 GitHub 登录"
              checked={draft.enabled}
              disabled={loading || busy !== null}
              onChange={(value) => patch({ enabled: value })}
            />
          }
        />
        <SettingRow
          name="Client ID"
          help="GitHub → Developer settings → OAuth Apps 创建应用后获得。"
          control={
            <Input
              value={draft.clientId}
              placeholder="Ov23li…"
              onChange={(value) => patch({ clientId: value })}
              style={{ width: 280 }}
            />
          }
        />
        <SettingRow
          name="Client Secret"
          help={summary?.secret_set ? "已保存，不回显；留空表示不修改。" : "生成后只显示一次。"}
          control={
            <Input
              mode="password"
              value={draft.clientSecret}
              placeholder={summary?.secret_set ? "已保存，留空不修改" : "粘贴 client secret"}
              onChange={(value) => patch({ clientSecret: value })}
              style={{ width: 280 }}
            />
          }
        />
        <SettingRow
          name="回调地址"
          help="需在 GitHub 应用的 Redirect URIs 里逐字登记。"
          control={
            <Typography.Text copyable ellipsis style={{ maxWidth: 280, fontSize: 12 }}>
              {`${window.location.origin}/api/auth/callback/github`}
            </Typography.Text>
          }
        />
        {checkResult ? (
          <div style={{ padding: "0 16px 8px" }}>
            <Banner
              type={checkResult.ok ? "success" : "danger"}
              description={checkResult.message}
              closeIcon={null}
            />
          </div>
        ) : null}
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 0 4px",
            borderTop: "1px solid var(--semi-color-border)",
          }}
        >
          <Button disabled={loading || busy !== null} loading={busy === "check"} onClick={() => void onCheck()}>
            校验凭据
          </Button>
          <Button
            type="danger"
            loading={busy === "delete"}
            disabled={loading || busy !== null || !summary?.configured}
            onClick={() => void onDelete()}
          >
            关闭
          </Button>
          <Button disabled={loading || busy !== null} theme="solid" loading={busy === "save"} onClick={() => void onSave()}>
            保存
          </Button>
        </div>
      </SettingSection>
    </>
  );
}
