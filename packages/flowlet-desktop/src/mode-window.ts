// 「运行模式 / 连接主机」设置窗口。
//
// 为什么不用页面内的设置页：主机模式与客户端模式互斥，切换意味着重启宿主进程；
// 且客户端模式还没连上远程时没有可用命令通道，必须有一个纯本地的配置入口。
//
// 窗口内容由本文件在运行时写成 userData/mode-window.html，再 loadFile 打开；
// 只用 dist-host/preload-mode.cjs 暴露的 5 个 IPC，不加载任何远程内容。
import { BrowserWindow } from "electron";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DesktopLogger } from "./logger.ts";

export interface ModeWindowOptions {
  readonly preloadPath: string;
  readonly htmlPath: string;
  readonly parent: BrowserWindow | null;
  readonly logger: DesktopLogger;
}

export function openModeWindow(options: ModeWindowOptions): BrowserWindow {
  const win = new BrowserWindow({
    width: 720,
    height: 620,
    minWidth: 640,
    minHeight: 560,
    resizable: true,
    title: "Flowlet 运行模式",
    autoHideMenuBar: true,
    parent: options.parent ?? undefined,
    modal: false,
    show: false,
    webPreferences: {
      preload: options.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.once("ready-to-show", () => win.show());
  ensureModeWindowHtml(options.htmlPath);
  void win.loadFile(options.htmlPath).catch((error: unknown) => {
    options.logger.warn("打开运行模式窗口失败", {
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return win;
}

/** 把设置页写到 userData（内容固定，不随版本变化时也重写，保证与主进程协议一致）。 */
export function ensureModeWindowHtml(htmlPath: string): void {
  mkdirSync(dirname(htmlPath), { recursive: true });
  writeFileSync(htmlPath, MODE_WINDOW_HTML, "utf8");
}

const MODE_WINDOW_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<title>Flowlet 运行模式</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 14px/1.55 system-ui, -apple-system, "Segoe UI", "PingFang SC", sans-serif; padding: 24px 28px 20px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.hint { margin: 0 0 18px; opacity: .72; font-size: 13px; }
  fieldset { border: 1px solid color-mix(in srgb, currentColor 18%, transparent); border-radius: 10px; padding: 14px 16px 16px; margin: 0 0 16px; }
  legend { padding: 0 6px; font-weight: 600; }
  label { display: block; margin: 10px 0 4px; font-size: 13px; }
  input[type=url], input[type=password] { width: 100%; box-sizing: border-box; padding: 8px 10px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 26%, transparent); background: transparent; color: inherit; font: inherit; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  .row + .row { margin-top: 8px; }
  button { font: inherit; padding: 8px 14px; border-radius: 8px; border: 1px solid color-mix(in srgb, currentColor 26%, transparent); background: transparent; color: inherit; cursor: pointer; }
  button.primary { background: #2f6fed; border-color: #2f6fed; color: #fff; }
  button:disabled { opacity: .55; cursor: default; }
  .status { min-height: 20px; font-size: 13px; margin-top: 12px; white-space: pre-wrap; }
  .status.ok { color: #1a7f37; }
  .status.err { color: #c93c37; }
  .muted { opacity: .65; font-size: 12px; }
  .hidden { display: none !important; }
  footer { display: flex; justify-content: flex-end; gap: 8px; margin-top: 6px; }
</style>
</head>
<body>
  <h1>Flowlet 运行模式</h1>
  <p class="hint">主机模式在本机运行模型代理并提供管理界面；客户端模式连接到 Docker / Web Host，只做远程观测与管理。切换后会重启应用。</p>

  <fieldset>
    <legend>运行模式</legend>
    <div class="row">
      <label class="row" style="margin:0"><input type="radio" name="mode" value="host"> 主机模式（本机）</label>
      <label class="row" style="margin:0"><input type="radio" name="mode" value="client"> 客户端模式（连接远程主机）</label>
    </div>
  </fieldset>

  <fieldset id="clientBox">
    <legend>远程主机</legend>
    <label for="baseUrl">管理台地址</label>
    <input id="baseUrl" type="url" placeholder="https://flowlet.example.com" autocomplete="off" spellcheck="false">
    <div class="muted" style="margin-top:6px">只填协议 + 域名（+ 端口），不要带路径。</div>
    <label>登录方式</label>
    <div class="row">
      <label class="row" style="margin:0"><input type="radio" name="authKind" value="token"> 管理凭据（token）</label>
      <label class="row" style="margin:0"><input type="radio" name="authKind" value="session"> 企业 SSO（OIDC）</label>
    </div>
    <div id="tokenBox" class="hidden">
      <label for="token">管理凭据</label>
      <input id="token" type="password" placeholder="部署时设置的 FLOWLET_ADMIN_TOKEN" autocomplete="off">
      <div class="muted" id="tokenHint" style="margin-top:6px"></div>
    </div>
    <div class="row" style="margin-top:14px">
      <button id="testBtn">测试连接</button>
      <button id="loginBtn" class="hidden">打开登录窗口</button>
    </div>
  </fieldset>

  <div id="status" class="status"></div>

  <footer>
    <button id="cancelBtn">取消</button>
    <button id="saveBtn" class="primary">保存并重启</button>
  </footer>

<script>
  const $ = (id) => document.getElementById(id);
  const statusEl = $("status");
  const clientBox = $("clientBox");
  const tokenBox = $("tokenBox");
  const tokenHint = $("tokenHint");
  const loginBtn = $("loginBtn");
  let current = { mode: "host", baseUrl: "", authKind: "token", hasToken: false, safeStorage: true };

  function setStatus(text, kind) {
    statusEl.textContent = text || "";
    statusEl.className = "status" + (kind ? " " + kind : "");
  }

  function selectedMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }
  function selectedAuth() {
    return document.querySelector('input[name="authKind"]:checked').value;
  }

  function syncVisibility() {
    const client = selectedMode() === "client";
    clientBox.classList.toggle("hidden", !client);
    tokenBox.classList.toggle("hidden", !client || selectedAuth() !== "token");
    loginBtn.classList.toggle("hidden", !client || selectedAuth() !== "session");
  }

  async function load() {
    const data = await window.flowletMode.load();
    current = data;
    document.querySelector('input[name="mode"][value="' + data.mode + '"]').checked = true;
    $("baseUrl").value = data.baseUrl || "";
    document.querySelector('input[name="authKind"][value="' + (data.authKind || "token") + '"]').checked = true;
    $("token").value = "";
    tokenHint.textContent = data.hasToken
      ? "已保存管理凭据（留空则保持不变）"
      : data.safeStorage
        ? "凭据会用系统密钥链加密保存"
        : "当前环境没有可用的系统密钥链，凭据将降级为本地明文保存";
    syncVisibility();
  }

  function payload(includeToken) {
    const mode = selectedMode();
    if (mode === "host") return { mode };
    const baseUrl = $("baseUrl").value.trim();
    const authKind = selectedAuth();
    const out = { mode, baseUrl, authKind };
    const token = $("token").value.trim();
    if (includeToken && authKind === "token" && token !== "") out.token = token;
    return out;
  }

  $("testBtn").addEventListener("click", async () => {
    setStatus("正在测试连接…");
    try {
      const result = await window.flowletMode.test({
        baseUrl: $("baseUrl").value.trim(),
        authKind: selectedAuth(),
        token: $("token").value.trim() || undefined,
      });
      setStatus(result.message || (result.ok ? "连接成功" : "连接失败"), result.ok ? "ok" : "err");
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), "err");
    }
  });

  $("loginBtn").addEventListener("click", async () => {
    setStatus("已打开登录窗口，请完成企业 SSO 登录…");
    try {
      const result = await window.flowletMode.login({ baseUrl: $("baseUrl").value.trim() });
      setStatus(result.message || "登录成功", result.ok ? "ok" : "err");
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), "err");
    }
  });

  $("saveBtn").addEventListener("click", async () => {
    setStatus("正在保存并重启…");
    try {
      const result = await window.flowletMode.save(payload(true));
      if (result && result.ok === false) setStatus(result.message || "保存失败", "err");
    } catch (error) {
      setStatus(String(error && error.message ? error.message : error), "err");
    }
  });

  $("cancelBtn").addEventListener("click", () => { void window.flowletMode.close(); });

  for (const el of document.querySelectorAll('input[name="mode"], input[name="authKind"]')) {
    el.addEventListener("change", syncVisibility);
  }

  load().catch((error) => setStatus(String(error && error.message ? error.message : error), "err"));
</script>
</body>
</html>
`;
