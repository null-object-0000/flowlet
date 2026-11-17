import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner, Button, Input, Select, Typography } from "@douyinfe/semi-ui-19";
import { invokeWebCommand, type WebIdentity } from "../platform/web/client";
import { copyText } from "../shared/ui/copyText";
import styles from "./WebApp.module.css";
type Session = {
    id: string;
    provider: string;
    createdAt: string;
    lastSeenAt: string;
    current: boolean;
};
type Token = {
    id: string;
    name: string;
    scope?: string;
    prefix?: string;
    expiresAt: string;
};
export function PersonalAccessPanel({ identity }: {
    identity?: WebIdentity | null;
}) {
    const qc = useQueryClient();
    const [name, setName] = useState("");
    const [scope, setScope] = useState("observe");
    const [days, setDays] = useState("30");
    const [secret, setSecret] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const enabled = Boolean(identity?.userId);
    const sessions = useQuery({ queryKey: ["my-sessions", identity?.userId], queryFn: () => invokeWebCommand<Session[]>("list_my_sessions"), enabled });
    const tokens = useQuery({ queryKey: ["my-tokens", identity?.userId], queryFn: () => invokeWebCommand<Token[]>("list_my_tokens"), enabled });
    const cli = useQuery({ queryKey: ["my-cli-tokens", identity?.userId], queryFn: () => invokeWebCommand<Token[]>("list_my_cli_tokens"), enabled });
    async function run(command: string, args: Record<string, unknown> = {}) {
        setBusy(true);
        setError("");
        try {
            const result = await invokeWebCommand<{
                token?: string;
            }>(command, args);
            if (result?.token) {
                setSecret(result.token);
                setName("");
            }
            await Promise.all([qc.invalidateQueries({ queryKey: ["my-sessions"] }), qc.invalidateQueries({ queryKey: ["my-tokens"] }), qc.invalidateQueries({ queryKey: ["my-cli-tokens"] })]);
            return true;
        }
        catch (e) {
            setError(e instanceof Error ? e.message : "操作失败");
            return false;
        }
        finally {
            setBusy(false);
        }
    }
    if (!enabled)
        return <div className={styles.users}><Banner type="info" description="个人访问需要使用 GitLab、GitHub 等个人账号登录。静态管理凭据属于实例管理员，不关联个人身份。"/></div>;
    return <div className={styles.users}>
    {(error || sessions.error || tokens.error || cli.error) && <Banner type="danger" description={error || String(sessions.error || tokens.error || cli.error)}/>}
    <Typography.Title heading={5}>个人 API 凭据</Typography.Title>
    <Typography.Paragraph type="tertiary">供脚本通过 Authorization: Bearer 调用管理 HTTP API。凭据权限受你的当前角色约束，停用账号或撤销后立即失效。选择“模型调用”可直接用于模型 API，并按个人凭据记录调用归属。共享客户端 Token 继续可用。</Typography.Paragraph>
    <form className={styles.accessForm} onSubmit={event => { event.preventDefault(); void run("create_personal_token", { name, scope, days: Number(days) }); }}>
      <Input aria-label="凭据名称" placeholder="名称，例如：巡检脚本" value={name} onChange={setName} maxLength={100}/>
      <Select aria-label="凭据作用域" value={scope} onChange={v => setScope(String(v))} optionList={[{ value: "observe", label: "只读观测" }, ...(identity?.role !== "viewer" ? [{ value: "credentials:read", label: "读取服务凭据" }, { value: "models:invoke", label: "模型调用" }] : [])]}/>
      <Select aria-label="凭据有效期" value={days} onChange={v => setDays(String(v))} optionList={[{ value: "7", label: "7天" }, { value: "30", label: "30天" }, { value: "90", label: "90天" }]}/>
      <Button htmlType="submit" theme="solid" loading={busy} disabled={!name.trim()}>创建凭据</Button>
    </form>
    {secret && <section className={styles.newSecret}>
      <Banner type="warning" description="新凭据仅在此处显示一次，请保存后关闭。"/>
      <code>{secret}</code><div><Button onClick={() => void copyText(secret).catch(() => setError("复制失败，请手动复制"))}>复制</Button><Button onClick={() => setSecret("")}>关闭并清除</Button></div>
    </section>}
    {tokens.isPending ? <p role="status">正在读取凭据…</p> : tokens.data?.length === 0 ? <p>还没有个人 API 凭据。</p> : null}
    {tokens.data?.map(token => <div key={token.id} className={styles.userRow}><div><strong>{token.name}</strong><p>{token.prefix}… · {token.scope} · {new Date(token.expiresAt).toLocaleDateString()} 到期</p></div><Button disabled={busy} type="danger" onClick={() => void run("revoke_personal_token", { id: token.id })}>撤销</Button></div>)}
    <Typography.Title heading={5}>已授权 CLI</Typography.Title>
    <Typography.Paragraph type="tertiary">使用 flowlet login 授权的终端，权限为读取服务凭据。历史共享授权由管理员在服务凭据页管理。</Typography.Paragraph>
    {cli.data?.length === 0 ? <p>还没有关联到你的 CLI 授权。</p> : null}
    {cli.data?.map(token => <div key={token.id} className={styles.userRow}><div><strong>{token.name}</strong><p>{new Date(token.expiresAt).toLocaleDateString()} 到期</p></div><Button disabled={busy} type="danger" onClick={() => void run("revoke_my_cli_token", { id: token.id })}>撤销</Button></div>)}
    <Typography.Title heading={5}>登录会话</Typography.Title>
    <Button disabled={busy || !sessions.data?.some(s => !s.current)} onClick={() => void run("revoke_my_other_sessions")}>退出其他设备</Button>
    {sessions.data?.map(session => <div key={session.id} className={styles.userRow}><div><strong>{session.provider}{session.current ? " · 当前会话" : ""}</strong><p>最近活动 {new Date(session.lastSeenAt).toLocaleString()}</p></div><Button disabled={busy} onClick={async () => { const ok = await run("revoke_my_session", { id: session.id }); if (ok && session.current)
        window.location.reload(); }}>退出此会话</Button></div>)}
  </div>;
}
