import { cloneElement, useCallback, useEffect, useId, useMemo, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Button, Input, Select, Switch, TextArea, Toast, Typography } from "@douyinfe/semi-ui-19";
import { errorMessage } from "../../../shared/errors/AppError";
import {
  checkOidcAuthProvider,
  deleteOidcAuthProvider,
  getAdminLoginMode,
  getOidcAuthProvider,
  saveAdminLoginMode,
  saveOidcAuthProvider,
  type OidcCheckItem,
  type OidcCheckResult,
  type OidcProviderSummary,
} from "../../../domains/settings/oidcAuthProvider";
import {
  EMPTY_OIDC_DRAFT,
  draftFromSummary,
  payloadFromDraft,
  validateDraft,
  type OidcDraft,
} from "../../../domains/settings/oidcDraft";
import styles from "./OidcAuthSection.module.css";

const CALLBACK_ORIGIN = () =>
  typeof window === "undefined" ? "http://your-flowlet-host" : window.location.origin.replace(/\/+$/, "");

type Props = {
  /** 保存 / 移除后通知父级刷新 GitHub 摘要与开关状态。 */
  onSaved: () => void;
};

type Status = { tone: "ok" | "warn" | "off" | "info"; label: string };

function Badge({ tone, children }: { tone: Status["tone"]; children: ReactNode }) {
  const toneClass = tone === "ok" ? styles.badgeOk : tone === "warn" ? styles.badgeWarn : tone === "off" ? styles.badgeOff : styles.badgeInfo;
  return (
    <span className={`${styles.badge} ${toneClass}`}>
      <span className={styles.badgeDot} aria-hidden="true" />
      {children}
    </span>
  );
}

function Card({
  step,
  title,
  hint,
  action,
  done,
  children,
}: {
  step?: number;
  title: string;
  hint?: string;
  action?: ReactNode;
  done?: boolean;
  children?: ReactNode;
}) {
  return (
    <section className={styles.card} data-keywords={`oidc gitlab 登录 sso ${title}`}>
      <header className={styles.cardHead}>
        {step !== undefined && (
          <span className={`${styles.stepNo} ${done ? styles.stepNoDone : ""}`} aria-hidden="true">
            {done ? "✓" : step}
          </span>
        )}
        <div className={styles.cardCopy}>
          <div className={styles.cardTitle}>{title}</div>
          {hint ? <div className={styles.cardHint}>{hint}</div> : null}
        </div>
        {action ? <div className={styles.cardAction}>{action}</div> : null}
      </header>
      {children ? <div className={styles.cardBody}>{children}</div> : null}
    </section>
  );
}

/** 控件 + 标题/说明。label 用 htmlFor 指向控件 id，并补 aria-label（测试/读屏都按标题定位）。 */
function Field({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  /** Semi 的 Input / TextArea 都是 forwardRef，ref 直接落到原生控件上，用它做 label 关联。 */
  children: ReactElement<{ ref?: React.Ref<HTMLTextAreaElement | HTMLInputElement>; "aria-label"?: string }>;
}) {
  const id = useId();
  const control = cloneElement(children, {
    ref: (node: HTMLTextAreaElement | HTMLInputElement | null) => {
      if (node !== null) node.id = id;
    },
    // Semi 的 TextField 把原生 textarea 包在 div 里，`for=` 关联在部分浏览器/测试环境里不稳；
    // 同步补一个 aria-label，读屏与自动化都按「标题」定位。
    "aria-label": children.props["aria-label"] ?? label,
  });
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
        {required ? <span className={styles.required}>*</span> : null}
      </label>
      {control}
      {help ? <span className={styles.help}>{help}</span> : null}
    </div>
  );
}

/** 与 `Field` 同样式，但控件是原生 select（Semi Select 不能放进 label 里正确关联）。 */

function CheckIcon({ status }: { status: OidcCheckItem["status"] }) {
  const cls = status === "ok" ? styles.checkOk : status === "warning" ? styles.checkWarn : styles.checkError;
  return (
    <span className={`${styles.checkIcon} ${cls}`} aria-hidden="true">
      {status === "ok" ? "✓" : status === "warning" ? "!" : "×"}
    </span>
  );
}

/**
 * 「登录与访问」——GitLab / OIDC 登录（自助配置）。
 *
 * 设计目标：管理员不读部署文档也能走完「新建 GitLab 应用 → 填地址与凭据 →
 * 谁能管理 → 校验 → 启用」。因此按步骤分卡片，而不是一长串设置项：
 * 1 应用地址与凭据；2 谁能登录 / 谁能管理（实时预览角色规则）；3 校验；高级项折叠。
 *
 * 部署字段（issuer / client / 回调）现在也在界面里，保存即热生效；`env` 来源表示当前
 * 仍在沿用部署环境变量，界面会明确提示「保存一次即由界面接管」。
 */
export function OidcAuthSection({ onSaved }: Props) {
  const [summary, setSummary] = useState<OidcProviderSummary | null>(null);
  const [oidcEnabled, setOidcEnabled] = useState(false);
  const [draft, setDraft] = useState<OidcDraft>(EMPTY_OIDC_DRAFT);
  const [baseline, setBaseline] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"save" | "check" | "delete" | null>(null);
  const [checkResult, setCheckResult] = useState<OidcCheckResult | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const originRef = useRef<string>(CALLBACK_ORIGIN());

  const reload = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [nextSummary, mode] = await Promise.all([getOidcAuthProvider(), getAdminLoginMode()]);
      const nextDraft = draftFromSummary(nextSummary, mode.enabled.includes("oidc"), originRef.current);
      setSummary(nextSummary);
      setOidcEnabled(mode.enabled.includes("oidc"));
      setDraft(nextDraft);
      setBaseline(JSON.stringify(nextDraft));
    } catch (error) {
      setLoadError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const patch = (next: Partial<OidcDraft>) => {
    setFormError(null);
    setDraft((current) => ({ ...current, ...next }));
  };

  const dirty = useMemo(() => JSON.stringify(draft) !== baseline, [draft, baseline]);

  const configured = summary?.configured === true;
  const status: Status = !configured
    ? { tone: "off", label: "尚未配置" }
    : oidcEnabled
      ? summary?.source === "env"
        ? { tone: "warn", label: "启用中（沿用部署环境变量）" }
        : { tone: "ok", label: "启用中" }
      : { tone: "info", label: "已配置，未启用" };

  /** 只改 OIDC 这一个开关：把另一个提供方（GitHub）的当前状态原样带上。 */
  const commitEnabled = async (enabled: boolean): Promise<string[]> => {
    const current = await getAdminLoginMode();
    const others = current.enabled.filter((id) => id !== "oidc");
    const next = [...others, ...(enabled ? (["oidc"] as const) : [])];
    await saveAdminLoginMode(next);
    const mode = await getAdminLoginMode();
    setOidcEnabled(mode.enabled.includes("oidc"));
    return mode.enabled;
  };

  const onCheck = async () => {
    setBusy("check");
    setCheckResult(null);
    setFormError(null);
    try {
      const result = await checkOidcAuthProvider(payloadFromDraft(draft, summary?.source === "stored" ? summary.generation : null));
      setCheckResult(result);
      if (result.ok) Toast.success(result.message);
      else Toast.error(result.message);
    } catch (error) {
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onSave = async () => {
    const problem = validateDraft(draft, summary?.secret_set === true);
    // 这里只校验认证连接字段；准入与角色由实例策略负责。
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    setBusy("save");
    try {
      const result = await saveOidcAuthProvider(
        payloadFromDraft(draft, summary?.source === "stored" ? summary.generation : null),
      );
      // 先落库，再按草稿里的开关同步；被拒绝（例如没有兜底登录方式）时库里已经是新配置，
      // 所以失败后仍要刷新，让界面显示真实状态。
      try {
        await commitEnabled(draft.enabled);
      } finally {
        await reload();
        onSaved();
      }
      Toast.success(
        result.adopted_endpoints
          ? "已保存并生效；已根据校验结果自动填写 discovery 地址"
          : "已保存，立即生效",
      );
    } catch (error) {
      setFormError(errorMessage(error));
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const onDelete = async () => {
    // 移除 = 让登录页不再提供这个入口；先关开关（服务端会确认还有别的登录方式），
    // 顺序反了可能出现「配置已删、入口还开着」的瞬间。
    if (oidcEnabled) {
      try {
        await commitEnabled(false);
      } catch (error) {
        setFormError(errorMessage(error));
        Toast.error(errorMessage(error));
        return;
      }
    }
    setBusy("delete");
    try {
      await deleteOidcAuthProvider();
      setCheckResult(null);
      await reload();
      onSaved();
      Toast.success("已移除 GitLab 登录配置，登录页不再提供该入口");
    } catch (error) {
      setFormError(errorMessage(error));
      Toast.error(errorMessage(error));
    } finally {
      setBusy(null);
    }
  };

  const toggleEnabled = (enabled: boolean) => {
    // 开关只改草稿；统一由「保存」落库，避免「配置还没填好就打开了入口」。
    patch({ enabled });
  };


  return (
    <div className={styles.root} data-keywords="gitlab oidc 单点登录 sso 准入 管理员 只读 登录方式">
      <header className={styles.hero}>
        <span className={styles.heroIcon} aria-hidden="true">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
            <path d="M12 3 4 6v6c0 4.4 3.4 8.1 8 9 4.6-.9 8-4.6 8-9V6z" />
            <path d="m9 12 2 2 4-4" />
          </svg>
        </span>
        <div className={styles.heroText}>
          <div className={styles.heroTitle}>
            {summary?.display_name || "GitLab"} 单点登录
            {loading ? <Badge tone="info">读取中…</Badge> : <Badge tone={status.tone}>{status.label}</Badge>}
            {summary?.source === "stored" && configured ? <Badge tone="info">界面配置</Badge> : null}
          </div>
          <div className={styles.heroMeta}>
            {summary?.issuer ? `issuer：${summary.issuer}` : "用公司 GitLab 账号登录管理台，替代共享管理凭据"}
          </div>
        </div>
        <div className={styles.heroSwitch}>
          <span>登录页展示</span>
          <Switch
            aria-label="在登录页启用 GitLab 登录"
            checked={draft.enabled}
            disabled={loading}
            onChange={toggleEnabled}
          />
        </div>
      </header>

      {loadError ? (
        <div className={styles.inlineError}>读取登录配置失败：{loadError}</div>
      ) : null}

      <Card
        step={1}
        title="绑定 GitLab 应用"
        hint="在 GitLab「用户设置 → Applications」新建应用，回调地址填下方地址，Scopes 只勾 openid。"
        done={draft.issuer !== "" && draft.clientId !== "" && summary?.secret_set === true}
        action={
          <Button loading={busy === "check"} onClick={() => void onCheck()}>
            校验连接
          </Button>
        }
      >
        <div className={styles.grid}>
          <Field label="GitLab 地址（issuer）" required help="示例：https://git.example.com；旧版自建 GitLab 可能是 http。">
            <Input value={draft.issuer} placeholder="https://git.example.com" disabled={loading} onChange={(value) => patch({ issuer: value })} />
          </Field>
          <Field label="Discovery 地址" help="留空即使用「issuer/.well-known/openid-configuration」。">
            <Input value={draft.discoveryUrl} placeholder="自动推导" disabled={loading} onChange={(value) => patch({ discoveryUrl: value })} />
          </Field>
          <Field label="Application ID" required>
            <Input value={draft.clientId} placeholder="GitLab 应用页里的 Application ID" disabled={loading} onChange={(value) => patch({ clientId: value })} />
          </Field>
          <Field
            label="Application Secret"
            required={summary?.secret_set !== true}
            help={summary?.secret_set ? "已保存，不会回显；留空表示不修改。" : "GitLab 只显示一次，请立即填入。"}
          >
            <Input
              mode="password"
              value={draft.clientSecret}
              placeholder={summary?.secret_set ? "••••••••（留空不修改）" : "粘贴 Application Secret"}
              disabled={loading}
              onChange={(value) => patch({ clientSecret: value })}
            />
          </Field>
          <div className={styles.span2}>
            <Field label="回调地址" help="必须与 GitLab 应用里登记的 Redirect URI 完全一致（每个访问入口一条）。">
              <TextArea
                autosize={{ minRows: 1, maxRows: 4 }}
                value={draft.redirectUrls}
                disabled={loading}
                onChange={(value) => patch({ redirectUrls: value })}
              />
            </Field>
          </div>
        </div>
      </Card>

      <p className={styles.help}>登录准入与管理员角色统一在「用户管理」设置。</p>

      <Card
        step={2}
        title="连接校验"
        hint="校验 discovery、issuer 一致性、应用凭据与 PKCE 能力；回调地址请在 GitLab 应用里核对。"
        action={
          <Button loading={busy === "check"} onClick={() => void onCheck()}>
            开始校验
          </Button>
        }
      >
        {checkResult ? (
          <div className={styles.checkList}>
            {checkResult.items.map((item) => (
              <div key={item.key} className={styles.checkItem}>
                <CheckIcon status={item.status} />
                <span className={styles.checkText}>{item.message}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className={styles.help}>还没有校验结果。填好上方内容后点「开始校验」，失败项会逐条列在这里。</div>
        )}
      </Card>

      <details className={styles.advanced}>
        <summary className={styles.advancedSummary}>高级设置（显示名称、协议参数、身份声明、旧版 GitLab）</summary>
        <div className={styles.advancedBody}>
          <div className={styles.grid}>
            <Field label="显示名称" help="登录页按钮上的文字。">
              <Input value={draft.displayName} disabled={loading} onChange={(value) => patch({ displayName: value })} />
            </Field>
            <Field label="Scopes" help="必须包含 openid。">
              <Input value={draft.scopes} disabled={loading} onChange={(value) => patch({ scopes: value })} />
            </Field>
            <Field label="PKCE">
              <Select
                aria-label="PKCE"
                value={draft.pkce}
                disabled={loading}
                onChange={(value) => patch({ pkce: value as OidcDraft["pkce"] })}
                optionList={[
                  { value: "auto", label: "auto（跟随 IdP 能力）" },
                  { value: "required", label: "required" },
                  { value: "off", label: "off" },
                ]}
              />
            </Field>
            <Field label="nonce">
              <Select
                aria-label="nonce"
                value={draft.nonce}
                disabled={loading}
                onChange={(value) => patch({ nonce: value as OidcDraft["nonce"] })}
                optionList={[
                  { value: "required", label: "required" },
                  { value: "best_effort", label: "best_effort" },
                  { value: "off", label: "off" },
                ]}
              />
            </Field>
            <Field label="邮箱声明（claim）">
              <Input value={draft.claims.email} disabled={loading} onChange={(value) => patch({ claims: { ...draft.claims, email: value } })} />
            </Field>
            <Field label="姓名声明">
              <Input value={draft.claims.name} disabled={loading} onChange={(value) => patch({ claims: { ...draft.claims, name: value } })} />
            </Field>
            <Field label="组声明">
              <Input value={draft.claims.groups} disabled={loading} onChange={(value) => patch({ claims: { ...draft.claims, groups: value } })} />
            </Field>
            <Field label="允许 http issuer" help="仅旧版自建 GitLab 内网链路勾选；公网入口务必使用 https。">
              <Switch checked={draft.allowHttpIssuer} disabled={loading} onChange={(value) => patch({ allowHttpIssuer: value })} />
            </Field>
          </div>
        </div>
      </details>

      <div className={styles.footer}>
        <div className={styles.footerStatus}>
          {formError ? (
            <span className={styles.inlineError}>{formError}</span>
          ) : dirty ? (
            <span className={styles.dirty}>有未保存的修改</span>
          ) : (
            <Typography.Text type="tertiary">保存后立即生效，不需要重启服务</Typography.Text>
          )}
        </div>
        <Button
          type="danger"
          theme="borderless"
          loading={busy === "delete"}
          disabled={!configured || summary?.source !== "stored" || loading}
          onClick={() => void onDelete()}
        >
          移除配置
        </Button>
        <Button loading={busy === "check"} onClick={() => void onCheck()}>
          校验
        </Button>
        <Button theme="solid" loading={busy === "save"} disabled={loading} onClick={() => void onSave()}>
          保存
        </Button>
      </div>
    </div>
  );
}
