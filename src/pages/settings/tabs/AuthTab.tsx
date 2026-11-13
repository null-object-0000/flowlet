import { useEffect, useMemo, useState } from "react";
import { Banner, Button, Input, Switch, TextArea, Toast, Typography } from "@douyinfe/semi-ui-19";
import { SettingRow, SettingSection } from "../SettingRow";
import { errorMessage } from "../../../shared/errors/AppError";
import {
  checkGithubAuthProvider,
  deleteGithubAuthProvider,
  getGithubAuthProvider,
  saveGithubAuthProvider,
  splitListInput,
  type GithubProviderSummary,
} from "../../../domains/settings/authProviders";
import {
  getAdminLoginMode,
  saveAdminLoginMode,
  type AdminLoginMode,
  type LoginProviderId,
} from "../../../domains/settings/oidcAuthProvider";
import { OidcAuthSection } from "./OidcAuthSection";

/** 名单统一用「一行一个」的文本框：含 @ 的算邮箱，其余算登录名。 */
function splitIdentities(value: string): { logins: string[]; emails: string[] } {
  const items = splitListInput(value);
  return {
    logins: items.filter((item) => !item.includes("@")),
    emails: items.filter((item) => item.includes("@")),
  };
}

function joinIdentities(logins: string[], emails: string[]): string {
  return [...logins, ...emails].join("\n");
}

type Draft = {
  enabled: boolean;
  clientId: string;
  clientSecret: string;
  allowed: string;
  admins: string;
  orgs: string;
  allowAny: boolean;
};

const EMPTY_DRAFT: Draft = {
  enabled: false,
  clientId: "",
  clientSecret: "",
  allowed: "",
  admins: "",
  orgs: "",
  allowAny: false,
};

/**
 * 「登录与访问」：管理台登录方式的管理员自助配置。
 *
 * 两段：GitLab / OIDC 与 GitHub OAuth。每段都有「启用」开关——开启哪些登录方式由管理员
 * 自己决定，而不是由部署环境写死。配好之后登录页会列出已启用的按钮；「可登录」决定谁能
 * 进来，「管理员」决定进来之后能不能改东西（没列进管理员的是只读）。
 */
export function AuthTab() {
  const [summary, setSummary] = useState<GithubProviderSummary | null>(null);
  const [loginMode, setLoginMode] = useState<AdminLoginMode | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [oidcBusy, setOidcBusy] = useState(false);
  const [busy, setBusy] = useState<"save" | "check" | "delete" | null>(null);
  const [checkResult, setCheckResult] = useState<{ ok: boolean; message: string } | null>(null);

  const reload = async () => {
    setLoading(true);
    try {
      const [next, mode] = await Promise.all([getGithubAuthProvider(), getAdminLoginMode()]);
      setSummary(next);
      setLoginMode(mode);
      setDraft({
        enabled: mode.enabled.includes("github"),
        clientId: next.client_id,
        clientSecret: "",
        allowed: joinIdentities(next.allowed_logins, next.allowed_emails),
        admins: joinIdentities(next.admin_logins, next.admin_emails),
        orgs: next.allowed_orgs.join(", "),
        allowAny: next.allow_any,
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
    const allowed = splitIdentities(draft.allowed);
    const admins = splitIdentities(draft.admins);
    return {
      client_id: draft.clientId.trim(),
      client_secret: draft.clientSecret,
      allowed_logins: allowed.logins,
      allowed_emails: allowed.emails,
      admin_logins: admins.logins,
      admin_emails: admins.emails,
      allowed_orgs: splitListInput(draft.orgs),
      allow_any: draft.allowAny,
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

  /** 只改 GitHub 这一个开关：另一个提供方的状态原样带上，两个开关一起保存。 */
  const commitGithubEnabled = async (enabled: boolean) => {
    const current = (await getAdminLoginMode()).enabled;
    const others = current.filter((id): id is LoginProviderId => id !== "github");
    await saveAdminLoginMode([...others, ...(enabled ? (["github"] as LoginProviderId[]) : [])]);
    setLoginMode(await getAdminLoginMode());
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

  return (
    <>
      <OidcAuthSection loginMode={loginMode} disabled={busy !== null} onBusyChange={setOidcBusy} onSaved={() => void reload()} />
      <SettingSection
        title="GitHub 登录"
        note={
          loading
            ? "读取中…"
            : (summary?.configured ? "已配置 · " : "未配置 · ") +
              "公网域名入口默认走 GitHub。改完立即生效，不需要重启服务。"
        }
        keywords="github oauth 登录 单点登录 sso 认证 角色 只读"
      >
        <SettingRow
          name="启用 GitHub 登录"
          help="登录页是否出现这个入口。关掉不影响已登录的会话。"
          control={
            <Switch
              checked={draft.enabled}
              disabled={loading || busy !== null || oidcBusy}
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
          name="可登录"
          help="一行一个，登录名或邮箱都行（含 @ 视为邮箱）。不填则任何人都进不来。"
          control={
            <TextArea
              autosize={{ minRows: 2, maxRows: 6 }}
              value={draft.allowed}
              placeholder={"changen\nsomeone@example.com"}
              onChange={(value) => patch({ allowed: value })}
              style={{ width: 280 }}
            />
          }
        />
        <SettingRow
          name="管理员"
          help="一行一个。列进来的是管理员，其余可登录的人只能只读浏览；不填则所有可登录者都是管理员。"
          control={
            <TextArea
              autosize={{ minRows: 2, maxRows: 6 }}
              value={draft.admins}
              placeholder="changen"
              onChange={(value) => patch({ admins: value })}
              style={{ width: 280 }}
            />
          }
        />
        <SettingRow
          name="可登录组织"
          help="填了会自动申请 read:org；组织成员可登录，但只读。"
          control={
            <Input
              value={draft.orgs}
              placeholder="acme"
              onChange={(value) => patch({ orgs: value })}
              style={{ width: 280 }}
            />
          }
        />
        <SettingRow
          name="允许任何人登录"
          help="管理台能读全部服务凭据，打开前请确认后果。"
          control={
            <Switch checked={draft.allowAny} onChange={(value) => patch({ allowAny: value })} />
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
        <div
          style={{
            display: "flex",
            justifyContent: "flex-end",
            gap: 8,
            padding: "12px 0 4px",
            borderTop: "1px solid var(--semi-color-border)",
          }}
        >
          <Button disabled={loading || busy !== null || oidcBusy} loading={busy === "check"} onClick={() => void onCheck()}>
            校验凭据
          </Button>
          <Button
            type="danger"
            loading={busy === "delete"}
            disabled={loading || busy !== null || oidcBusy || !summary?.configured}
            onClick={() => void onDelete()}
          >
            关闭
          </Button>
          <Button disabled={loading || busy !== null || oidcBusy} theme="solid" loading={busy === "save"} onClick={() => void onSave()}>
            保存
          </Button>
        </div>
        {checkResult && (
          <div style={{ padding: "0 16px 12px" }}>
            <Banner
              type={checkResult.ok ? "success" : "danger"}
              description={checkResult.message}
              closeIcon={null}
            />
          </div>
        )}
      </SettingSection>
    </>
  );
}
