import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner, Button, Input, Select, Switch, Typography } from "@douyinfe/semi-ui-19";
import { invokeWebCommand } from "../platform/web/client";
import styles from "./WebApp.module.css";
import { AccessPolicyPanel } from "./AccessPolicyPanel";
type User = { id: string; email: string | null; name: string | null; role: string; enabled: boolean; identities: string[]; lastLoginAt: string };
export function UsersPanel() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const users = useQuery({ queryKey: ["managed-users"], queryFn: () => invokeWebCommand<User[]>("list_managed_users") });
  async function update(user: User, patch: Partial<User>) {
    setBusy(user.id); setError("");
    try { await invokeWebCommand("update_managed_user", { id: user.id, role: user.role, enabled: user.enabled, ...patch }); await qc.invalidateQueries({ queryKey: ["managed-users"] }); }
    catch (e) { setError(e instanceof Error ? e.message : "更新失败"); }
    finally { setBusy(null); }
  }
  return <section className={styles.users} aria-label="用户管理">
    <AccessPolicyPanel />
    <Typography.Title heading={5}>谁能管理</Typography.Title>
    <Typography.Paragraph type="tertiary">用户首次登录后自动建立档案。已验证的相同邮箱默认关联到同一用户；角色与停用设置对所有关联登录方式生效。实例中的模型、凭据和运行数据仍为共享资源。</Typography.Paragraph>
    <Input aria-label="搜索用户" placeholder="搜索姓名或邮箱" value={search} onChange={setSearch} showClear />
    {(error || users.error) && <Banner type="danger" description={error || String(users.error)} />}
    {users.isPending ? <p role="status">正在读取用户…</p> : users.isError ? <Button onClick={() => void users.refetch()}>重试</Button> : !users.data?.length ? <p>还没有用户登录。使用单点登录后，用户会出现在这里。</p> : null}
    {users.data?.filter(user => `${user.name ?? ""} ${user.email ?? ""}`.toLowerCase().includes(search.toLowerCase())).map(user => <article key={user.id} className={styles.userRow}>
      <div><strong>{user.name || user.email || "未提供姓名"}</strong><p>{user.email || "尚无已验证邮箱"}</p><small>{user.identities.length} 个登录身份 · 最近登录 {new Date(user.lastLoginAt).toLocaleString()}</small><details><summary>查看登录身份</summary><ul>{user.identities.map(key => { let label = key; try { const value = JSON.parse(key); if (Array.isArray(value)) label = value.join(" · "); } catch { /* 兼容迁移中的旧身份键 */ } return <li key={key}>{label}</li>; })}</ul></details></div>
      <Select aria-label={`${user.name || user.email}的角色`} value={user.role} disabled={busy !== null} optionList={[{value:"admin",label:"管理员"},{value:"viewer",label:"只读用户"}]} onChange={value => void update(user, {role: String(value)})} />
      <label>启用 <Switch aria-label={`${user.name || user.email}的启用状态`} checked={user.enabled} disabled={busy !== null} onChange={enabled => void update(user, {enabled})} /></label>
    </article>)}
  </section>;
}
