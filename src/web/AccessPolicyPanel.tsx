import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Banner, Button, Select, Switch, TextArea, Typography } from "@douyinfe/semi-ui-19";
import { invokeWebCommand } from "../platform/web/client";
type Policy = { generation: number; mode: "existing" | "rules" | "all"; emails: string[]; domains: string[]; legacyRules: {issuer:string;kind:string;values:Record<string,unknown>}[] };
export function AccessPolicyPanel() {
  const qc = useQueryClient();
  const query = useQuery({queryKey:["access-policy"],queryFn:()=>invokeWebCommand<Policy>("get_access_policy")});
  const [draft,setDraft] = useState<Policy | null>(null);
  const [emails,setEmails] = useState("");
  const [domains,setDomains] = useState("");
  const [clearLegacy,setClearLegacy] = useState(false);
  const [busy,setBusy] = useState(false);
  const [error,setError] = useState("");
  const [saved,setSaved] = useState(false);
  useEffect(()=>{if(query.data){setDraft(query.data);setEmails(query.data.emails.join("\n"));setDomains(query.data.domains.join("\n"));setClearLegacy(false);}},[query.data]);
  async function save() {
    if(!draft)return;
    setBusy(true);setError("");setSaved(false);
    try {
      const split=(value:string)=>value.split(/[\s,，;；]+/).filter(Boolean);
      await invokeWebCommand("set_access_policy",{generation:draft.generation,mode:draft.mode,emails:split(emails),domains:split(domains),clearLegacy});
      await qc.invalidateQueries({queryKey:["access-policy"]});setSaved(true);
    } catch(e){setError(e instanceof Error?e.message:"保存失败");} finally{setBusy(false);}
  }
  return <section aria-label="实例登录准入">
    <Typography.Title heading={5}>谁能登录</Typography.Title>
    <Typography.Paragraph type="tertiary">准入策略对所有登录方式统一生效。已有用户由下方的启用状态控制；新用户默认只读，管理员角色在用户列表中分配。</Typography.Paragraph>
    {(error || query.error) && <Banner type="danger" description={error || String(query.error)} />}
    {saved && <Banner type="success" description="实例访问策略已保存" />}
    {draft ? <>
      <Select aria-label="新用户登录准入" value={draft.mode} disabled={busy} optionList={[{value:"existing",label:"仅已有用户"},{value:"rules",label:"允许指定邮箱或邮箱域的新用户"},{value:"all",label:"允许通过认证的所有新用户"}]} onChange={mode=>{setDraft({...draft,mode:mode as Policy["mode"]});setSaved(false);}} />
      {draft.mode==="rules" && <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(min(240px,100%),1fr))",gap:12,marginTop:12}}>
        <label>允许的邮箱<TextArea aria-label="允许的邮箱" value={emails} onChange={setEmails} placeholder="alice@example.com（一行一个）" disabled={busy} /></label>
        <label>允许的邮箱域<TextArea aria-label="允许的邮箱域" value={domains} onChange={setDomains} placeholder="example.com（一行一个）" disabled={busy} /></label>
        <small>邮箱规则仅匹配提供器已验证的邮箱，邮箱域不包含子域。</small>
      </div>}
      {draft.mode==="all" && <Banner type="warning" description="任何通过已启用登录方式认证的新用户都可进入管理台，初始角色为只读用户。" />}
      {draft.legacyRules.length>0 && <details style={{marginTop:12}}><summary>已迁移 {draft.legacyRules.length} 组旧访问规则</summary>
        <p>旧规则已独立保存在实例策略中，修改或删除登录提供器不会改写它们。保留期间，首次登录仍沿用原有准入和初始角色；选择「仅已有用户」时不接受新用户。</p>
        {draft.legacyRules.map((rule,index)=><div key={index}><strong>{rule.issuer}</strong><pre style={{whiteSpace:"pre-wrap",overflowWrap:"anywhere"}}>{JSON.stringify(rule.values,null,2)}</pre></div>)}
        <label><Switch aria-label="移除旧访问规则" checked={clearLegacy} disabled={busy} onChange={setClearLegacy} /> 保存时移除旧规则，今后统一使用上方邮箱策略；已有用户角色不变</label>
      </details>}
      <div style={{marginTop:12}}><Button theme="solid" loading={busy} onClick={()=>void save()}>保存访问策略</Button></div>
    </> : query.isPending ? <p role="status">正在读取访问策略…</p> : <Button onClick={()=>void query.refetch()}>重试</Button>}
  </section>;
}
