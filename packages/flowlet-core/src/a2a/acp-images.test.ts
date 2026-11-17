import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { it } from "node:test";
import { client, methods, type SessionUpdate } from "@agentclientprotocol/sdk";
import { startNativeAcp } from "./acp-native.ts";
import { createAcpBridge } from "../../../flowlet-cred/src/acp.ts";

for (const images of [false, true]) it(`native ACP negotiates image=${images} through Host and CLI and preserves tools`, async () => {
  const fixture = fileURLToPath(new URL("../../../flowlet-agent-bridge/test-agent.mjs", import.meta.url));
  const runtime = await startNativeAcp({ command: process.execPath, args: [fixture, ...(images ? ["--images"] : [])], cwd: path.dirname(fixture) }, 15);
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-native-image-"));
  let endpoint = "";
  const server = createServer(async (req, res) => {
    if (req.method === "GET") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ name: "Native image fixture", supportedInterfaces: [{ url: endpoint, protocolBinding: "JSONRPC", protocolVersion: "1.0" }], capabilities: { extensions: [{ uri: "urn:flowlet:acp-session:1" }] }, skills: [] }));
      return;
    }
    let body = ""; for await (const b of req) body += b;
    const rpc = JSON.parse(body);
    res.setHeader("content-type", "text/event-stream");
    const emit = async (frame: unknown) => { res.write(`data: ${JSON.stringify(frame)}\n\n`); };
    try { const result = await runtime.call(rpc.method, rpc.params, AbortSignal.timeout(15000), emit); await emit({ type: "result", result }); }
    catch (e: any) { await emit({ type: "error", code: e.code ?? -32000, message: e.message }); }
    res.end();
  });
  server.listen(0, "127.0.0.1"); await new Promise<void>(r => server.once("listening", r));
  endpoint = `http://127.0.0.1:${(server.address() as any).port}/agent`;
  const updates: SessionUpdate[] = [];
  try {
    await client({name:"image-contract"}).onNotification(methods.client.session.update, ({params}) => {updates.push(params.update);}).connectWith(createAcpBridge({url:endpoint,token:"test",prefix:"IMAGE",dir,timeoutSeconds:15}), async peer => {
      const init = await peer.request(methods.agent.initialize, {protocolVersion:1,clientCapabilities:{}});
      assert.equal(init.agentCapabilities?.promptCapabilities?.image, images);
      const {sessionId} = await peer.request(methods.agent.session.new, {cwd:dir,mcpServers:[]});
      const prompt = [{type:"text" as const,text:"image-check"},{type:"image" as const,mimeType:"image/png",data:"aGk="}];
      if(images){
        await peer.request(methods.agent.session.prompt,{sessionId,prompt});
        assert.equal(updates.filter(u=>u.sessionUpdate==='tool_call').length,1);
        assert.ok(updates.some(u=>u.sessionUpdate==='tool_call'&&(u.rawInput as Record<string,unknown>)?.images===1));
        assert.ok(updates.some(u=>u.sessionUpdate==='tool_call_update'&&u.status==='completed'));
      } else await assert.rejects(peer.request(methods.agent.session.prompt,{sessionId,prompt}),{code:-32602});
      for(const block of [{type:"resource_link" as const,uri:"file:///private",name:"secret"},{type:"image" as const,mimeType:"image/png",data:"bad%%%"}])
        await assert.rejects(peer.request(methods.agent.session.prompt,{sessionId,prompt:[block]}),{code:-32602});
    });
  } finally { server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); await runtime.close(); rmSync(dir,{recursive:true,force:true}); }
});
