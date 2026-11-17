import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { parseHostEvent, registerDialogHandlers } from "./renderer-capabilities.ts";
import type { FlowletDesktopBridge } from "../../../src/platform/desktop/bridge.ts";

test("dialog IPC exposes only open/save and normalizes selection/cancellation", async () => {
  const handlers = new Map<string, (event: string, options: unknown) => Promise<unknown>>();
  const calls: unknown[] = [];
  let canceled = false;
  registerDialogHandlers({
    handle: (channel, handler) => { handlers.set(channel, handler); },
    fromMainWindow: (event: string) => { assert.equal(event, "main"); return "parent-window"; },
    isHostMode: () => true,
    open: async (window, options) => { calls.push({ window, options }); return { canceled, filePaths: ["/one.json", "/two.json"] }; },
    save: async (window, options) => { calls.push({ window, options }); return { canceled, filePath: "/export.json" }; },
  });
  assert.deepEqual([...handlers.keys()], ["dialog:open", "dialog:save"]);
  const open = handlers.get("dialog:open")!;
  const save = handlers.get("dialog:save")!;
  assert.equal(await open("main", {}), "/one.json");
  assert.deepEqual(await open("main", { multiple: true, directory: true }), ["/one.json", "/two.json"]);
  assert.equal(await save("main", { defaultPath: "export.json", filters: [{ name: "JSON", extensions: ["json"] }], unknown: true }), "/export.json");
  assert.deepEqual(calls[1], { window: "parent-window", options: { title: undefined, defaultPath: undefined, filters: undefined, properties: ["openDirectory", "multiSelections"] } });
  canceled = true;
  assert.equal(await open("main", {}), null);
  assert.equal(await save("main", {}), null);
  await assert.rejects(open("other-window", {}));
  await assert.rejects(open("main", { filters: [{ name: "Bad", extensions: ["../json"] }] }), /过滤器/);
  await assert.rejects(save("main", "invalid"), /参数必须是对象/);
});

test("main rejects local file dialogs for client mode, even if IPC is forged", async () => {
  const handlers = new Map<string, (event: string, options: unknown) => Promise<unknown>>();
  registerDialogHandlers({
    handle: (channel, handler) => { handlers.set(channel, handler); },
    fromMainWindow: (event: string) => event,
    isHostMode: () => false,
    open: async () => { assert.fail("must not open a local dialog"); },
    save: async () => { assert.fail("must not save a local dialog"); },
  });
  for (const handler of handlers.values()) await assert.rejects(handler("main", {}), /客户端模式/);
});

test("Host event fanout permits only two fixed names and requires storage scan identity", () => {
  assert.deepEqual(parseHostEvent({ event: "agent-source-changed", payload: {} }), { event: "agent-source-changed", payload: {} });
  assert.deepEqual(parseHostEvent({ event: "storage-usage-progress", payload: { scanId: "scan", summary: {} } }).payload, { scanId: "scan", summary: {} });
  assert.throws(() => parseHostEvent({ event: "window:close" }), /不支持/);
  assert.throws(() => parseHostEvent({ event: "storage-usage-progress", payload: {} }), /scanId/);
});

function loadPreload(mode: "host" | "client") {
  let exposed: FlowletDesktopBridge | undefined;
  const invocations: unknown[][] = [];
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const context = {
    require: (id: string) => {
      assert.equal(id, "electron");
      return {
        contextBridge: { exposeInMainWorld: (name: string, value: FlowletDesktopBridge) => {
          assert.equal(name, "flowletDesktop"); exposed = value;
        } },
        ipcRenderer: {
          sendSync: (channel: string) => { assert.equal(channel, "desktop:bootstrap"); return { mode, adminToken: "local-only", clientBaseUrl: "https://remote.example" }; },
          invoke: async (...args: unknown[]) => { invocations.push(args); return null; },
          on: (channel: string, listener: (event: unknown, payload: unknown) => void) => { listeners.set(channel, listener); },
          removeListener: (channel: string) => { listeners.delete(channel); },
        },
      };
    },
    window: {},
  };
  const code = transformSync(readFileSync(new URL("./preload.ts", import.meta.url), "utf8"), { loader: "ts", format: "cjs" }).code;
  runInNewContext(code, context);
  assert.ok(exposed);
  return { api: exposed, invocations, listeners, context };
}

test("preload exposes typed capabilities, strips Electron events, and never exposes raw IPC", async () => {
  const { api, invocations, listeners, context } = loadPreload("host");
  assert.equal(api.adminToken, "local-only");
  assert.equal("invoke" in api, false);
  assert.deepEqual(Object.keys(context.window), []);
  await api.dialog!.open({ multiple: false });
  await api.dialog!.save({ defaultPath: "export.json" });
  await api.window!.close();
  assert.deepEqual(invocations.map((call) => call[0]), ["dialog:open", "dialog:save", "window:close"]);
  let received: unknown;
  const stop = api.events!.onStorageUsageProgress((payload) => { received = payload; });
  const payload = { scanId: "scan", summary: {} };
  listeners.get("host:event:storage-usage-progress")!({ sender: "must-not-leak" }, payload);
  assert.equal(received, payload);
  stop();
  assert.equal(listeners.size, 0);
});

test("client preload omits all local Host capabilities and management credentials", async () => {
  const { api, invocations } = loadPreload("client");
  assert.equal(api.adminToken, "");
  assert.equal(api.dialog, undefined);
  assert.equal(api.events, undefined);
  await api.window!.minimize();
  await api.openExternal!("https://example.com");
  assert.deepEqual(invocations.map((call) => call[0]), ["window:minimize", "platform:open-external"]);
});
