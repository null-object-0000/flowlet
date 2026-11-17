import { useQuery } from "@tanstack/react-query";
import { Banner, Button, Typography } from "@douyinfe/semi-ui-19";
import { invokeWebCommand } from "../platform/web/client";
import styles from "./WebApp.module.css";
type Entry = {
    id: string;
    createdAt: string;
    userId: string | null;
    credentialId: string | null;
    action: string;
    targetId: string | null;
    outcome: string;
};
export function SecurityAuditPanel() {
    const entries = useQuery({ queryKey: ["security-audit"], queryFn: () => invokeWebCommand<Entry[]>("list_security_audit") });
    const users = useQuery({ queryKey: ["managed-users"], queryFn: () => invokeWebCommand<{
            id: string;
            email: string | null;
            name: string | null;
        }[]>("list_managed_users") });
    const label = (id: string | null) => { const u = users.data?.find(u => u.id === id); return u?.email || u?.name || id || "实例管理员 / 旧共享授权"; };
    return <section className={styles.users}>
    <Typography.Paragraph type="tertiary">最近 200 条安全操作。记录操作者、凭据 ID、动作、目标与结果，不保存请求参数、凭据明文或导出内容。</Typography.Paragraph>
    <Button onClick={() => void entries.refetch()} loading={entries.isFetching}>刷新</Button>
    {entries.error && <Banner type="danger" description={String(entries.error)}/>}
    {entries.isPending ? <p role="status">正在读取审计…</p> : entries.data?.length === 0 ? <p>暂无安全操作记录。</p> : null}
    {entries.data?.map(entry => <article className={styles.userRow} key={entry.id}><div><strong>{entry.action}</strong><p>{label(entry.userId)} · {entry.outcome}</p><small>{new Date(entry.createdAt).toLocaleString()}{entry.targetId ? ` · 目标 ${entry.targetId}` : ""}{entry.credentialId ? ` · 凭据 ${entry.credentialId}` : ""}</small></div></article>)}
  </section>;
}
