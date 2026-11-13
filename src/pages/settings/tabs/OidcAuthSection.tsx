import { useCallback, useEffect, useMemo, useState } from "react";
import { Banner, Button, Input, Switch, TextArea, Toast, Typography } from "@douyinfe/semi-ui-19";
import { SettingRow, SettingSection } from "../SettingRow";
import { errorMessage } from "../../../shared/errors/AppError";
import { splitListInput } from "../../../domains/settings/authProviders";
import {
  checkOidcAuthProvider,
  deleteOidcAuthProvider,
  getAdminLoginMode,
  getOidcAuthProvider,
  saveAdminLoginMode,
  saveOidcAuthProvider,
  type AdminLoginMode,
  type OidcCheckResult,
  type OidcProviderInput,
  type OidcProviderSummary,
} from "../../../domains/settings/oidcAuthProvider";

/** GitLab 的 sub 是纯数字，邮箱一定带 @；分开放错行就是「谁能登录」写错人，所以严格按行归还。 */
function splitSubsAndEmails(value: string): { subs: string[]; emails: string[] } {
  const items = splitListInput(value);
  return {
    subs: items.filter((item) => !item.includes("@")),
    emails: items.filter((item) => item.includes("@")),
  };
}

function joinLines(values: string[]): string {
  return values.join("\n");
}

type Draft = {
  enabled: boolean;
  displayName: string;
  scopes: string;
  allowedUsers: string;
  allowedGroups: string;
  allowedDomains: string;
  admins: string;
  allowAny: boolean;
};

const EMPTY_DRAFT: Draft = {
  enabled: false,
  displayName: "GitLab",
  scopes: "openid",
  allowedUsers: "",
  allowedGroups: "",
  allowedDomains: "",
  admins: "",
  allowAny: false,
};

function draftFrom(summary: OidcProviderSummary, mode: AdminLoginMode | null): Draft {
  return {
    enabled: mode?.enabled.includes("oidc") ?? false,
    displayName: summary.display_name || "GitLab",
    scopes: summary.scopes || "openid",
    allowedUsers: joinLines([...summary.allowed_subs, ...summary.allowed_emails]),
    allowedGroups: joinLines(summary.allowed_groups),
    allowedDomains: joinLines(summary.allowed_domains),
    admins: joinLines([...summary.admin_subs, ...summary.admin_emails]),
    allowAny: summary.allow_any,
  };
}

function payloadFrom(draft: Draft): OidcProviderInput {
  const users = splitSubsAndEmails(draft.allowedUsers);
  const admins = splitSubsAndEmails(draft.admins);
  return {
    display_name: draft.displayName.trim(),
    scopes: draft.scopes.trim(),
    allowed_subs: users.subs,
    allowed_emails: users.emails,
    allowed_groups: splitListInput(draft.allowedGroups),
    allowed_domains: splitListInput(draft.allowedDomains),
    admin_subs: admins.subs,
    admin_emails: admins.emails,
    allow_any: draft.allowAny,
  };
}

type Props = {
  /** 保存任意登录设置后通知父级重新拉 GitHub 摘要。 */
  onSaved: () => void;
  loginMode: AdminLoginMode | null;
  disabled: boolean;
  onBusyChange: (busy: boolean) => void;
};

/**
 * 「登录与访问」里的 OIDC（自建 GitLab）配置。
 *
 * 解决的问题：以前 OIDC 的准入名单、管理员名单只能写进 compose 环境变量，改一次要重启
 * 容器；现在「谁能登录」「谁能管理」都在这里自助设置，保存即热生效。
 *
 * 部署级字段（issuer / client / 回调地址）也显示在这里，但说明它们仍需部署侧对齐——
 * 因为 GitLab 应用登记的回调地址、容器能否访问到 GitLab 都不是应用进程自己能保证的。
 */
export function OidcAuthSection({ onSaved, loginMode, disabled, onBusyChange }: Props) {
  const [summary, setSummary] = useState<OidcProviderSummary | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"save" | "check" | "delete" | null>(null);
  const [checkResult, setCheckResult] = useState<OidcCheckResult | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [nextSummary, nextMode] = await Promise.all([getOidcAuthProvider(), getAdminLoginMode()]);
      setSummary(nextSummary);
      setDraft(draftFrom(nextSummary, nextMode));
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    if (loginMode !== null) {
      setDraft(current => ({ ...current, enabled: loginMode.enabled.includes("oidc") }));
    }
  }, [loginMode]);

  useEffect(() => {
    onBusyChange(busy !== null);
    return () => onBusyChange(false);
  }, [busy, onBusyChange]);

  const patch = (next: Partial<Draft>) => setDraft((current) => ({ ...current, ...next }));

  const callbackUrl = useMemo(
    () => `${window.location.origin.replace(/\/+$/, "")}/api/auth/callback`,
    [],
  );

  /** 两个提供方的启用状态一起提交：OIDC 开关变化后本页 GitHub 摘要由父级刷新。 */
  const commitLoginMode = async (oidcEnabled: boolean) => {
    const current = (await getAdminLoginMode()).enabled;
    const others = current.filter(id => id !== "oidc");
    const enabled = oidcEnabled ? [...others, "oidc" as const] : others;
    await saveAdminLoginMode(enabled);
    const nextMode = await getAdminLoginMode();
    return nextMode;
  };

  const onSave = async () => {
    setBusy("save");
    try {
      await saveOidcAuthProvider(payloadFrom(draft));
      const nextMode = await commitLoginMode(draft.enabled);
      const latest = await getOidcAuthProvider();
      setSummary(latest);
      setDraft(draftFrom(latest, nextMode));
      Toast.success("已保存，立刻生效");
      onSaved();
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onCheck = async () => {
    setBusy("check");
    setCheckResult(null);
    try {
      const result = await checkOidcAuthProvider(payloadFrom(draft));
      setCheckResult(result);
      if (result.ok) Toast.success(result.message);
      else Toast.error(result.message);
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    setBusy("delete");
    try {
      await deleteOidcAuthProvider();
      setCheckResult(null);
      await reload();
      Toast.success("已移除界面上的 OIDC 配置，准入回落到部署环境变量");
      onSaved();
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const statusNote = loading
    ? "读取中…"
    : summary === null
      ? ""
      : summary.source === "stored"
        ? "已在此页面配置 · "
        : summary.source === "env"
          ? "沿用部署环境变量 · "
          : "尚未配置 · ";

  return (
    <SettingSection
      title="GitLab / OIDC 登录"
      note={
        statusNote +
        "设置谁能登录、谁能管理，保存后供新登录使用，无需重启；已有会话权限保持到退出或过期。"
      }
      keywords="gitlab oidc 单点登录 sso 准入 管理员 只读 登录方式"
    >
      {summary !== null && !summary.deployment_ready && (
        <div style={{ padding: "0 16px 8px" }}>
          <Banner
            type="warning"
            description="部署侧没有解析出 OIDC（缺少 FLOWLET_ADMIN_AUTH_MODE=oidc、FLOWLET_OIDC_ISSUER 或 client 凭据）。下面的开启开关要等部署补齐后才生效。"
            closeIcon={null}
          />
        </div>
      )}
      <SettingRow
        name="启用 OIDC 登录"
        help="登录页是否出现这个入口。关掉不影响已登录的会话。"
        control={
          <Switch
            checked={draft.enabled}
            disabled={disabled || loading || busy !== null || !summary?.deployment_ready}
            onChange={(value) => patch({ enabled: value })}
          />
        }
      />
      <SettingRow
        name="部署信息"
        help="Issuer、Discovery、Application ID / Secret、回调白名单与 PKCE 由部署环境管理。"
        control={<Typography.Text style={{ maxWidth: 280 }} ellipsis>{summary?.issuer || "尚未部署"}</Typography.Text>}
      />
      <SettingRow
        name="可登录"
        help="一行一个：GitLab 用户 ID（Users 设置页里的 sub）或邮箱（含 @）。不填则任何人都进不来。"
        control={
          <TextArea
            autosize={{ minRows: 2, maxRows: 6 }}
            value={draft.allowedUsers}
            placeholder={"94\nsomeone@company.com"}
            onChange={(value) => patch({ allowedUsers: value })}
            style={{ width: 280 }}
          />
        }
      />
      <SettingRow
        name="可登录组"
        help="一行一个 GitLab 组完整路径。组内成员可登录，默认只读；需要管理权限的人再写进下面。"
        control={
          <TextArea
            autosize={{ minRows: 2, maxRows: 6 }}
            value={draft.allowedGroups}
            placeholder={"platform/infra"}
            onChange={(value) => patch({ allowedGroups: value })}
            style={{ width: 280 }}
          />
        }
      />
      <SettingRow
        name="可登录邮箱域"
        help="一行一个域名，例如 company.com。同组一样默认只读，放得太宽等于全公司可见服务凭据。"
        control={
          <TextArea
            autosize={{ minRows: 2, maxRows: 4 }}
            value={draft.allowedDomains}
            placeholder={"company.com"}
            onChange={(value) => patch({ allowedDomains: value })}
            style={{ width: 280 }}
          />
        }
      />
      <SettingRow
        name="管理员"
        help="一行一个：用户 ID 或邮箱。列进来的人可以改配置；不填时「可登录」里直接列出的个人是管理员，按组/域进来的只读。"
        control={
          <TextArea
            autosize={{ minRows: 2, maxRows: 6 }}
            value={draft.admins}
            placeholder={"94"}
            onChange={(value) => patch({ admins: value })}
            style={{ width: 280 }}
          />
        }
      />
      <SettingRow
        name="显示名称"
        help="登录页按钮上的名字。"
        control={
          <Input
            value={draft.displayName}
            onChange={(value) => patch({ displayName: value })}
            style={{ width: 280 }}
          />
        }
      />
      <SettingRow
        name="Scopes"
        help="必须包含 openid；按身份源要求添加 profile、email 等。"
        control={<Input value={draft.scopes} onChange={value => patch({ scopes: value })} style={{ width: 280 }} />}
      />
      <SettingRow
        name="允许任何人登录"
        help="管理台能读全部服务凭据，打开前请确认后果。"
        control={<Switch checked={draft.allowAny} onChange={(value) => patch({ allowAny: value })} />}
      />
      <SettingRow
        name="回调地址"
        help="必须逐字登记在 GitLab 应用的 Redirect URI 里。"
        control={
          <Typography.Text copyable ellipsis style={{ maxWidth: 280, fontSize: 12 }}>
            {callbackUrl}
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
        <Button disabled={disabled || loading || busy !== null || !summary?.deployment_ready} loading={busy === "check"} onClick={() => void onCheck()}>
          校验配置
        </Button>
        <Button
          type="danger"
          loading={busy === "delete"}
          disabled={disabled || loading || busy !== null || !summary?.configured || summary.source !== "stored"}
          onClick={() => void onDelete()}
        >
          移除界面配置
        </Button>
        <Button disabled={disabled || loading || busy !== null || !summary?.deployment_ready} theme="solid" loading={busy === "save"} onClick={() => void onSave()}>
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
  );
}
