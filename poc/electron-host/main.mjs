// Flowlet migration PoC — Electron shell.
//
// Starts the Node command host in-process, then loads the UNCHANGED dist-web
// frontend from http://127.0.0.1:18787 — the same Web Host origin/contract the
// Rust headless host serves. `--screenshot=<png>` renders the real UI to a PNG
// and exits, so UI parity can be verified without manual interaction.
import { app, BrowserWindow } from "electron";
import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));

// Keep Chromium/Electron state (SingletonLock, cache) inside the workspace: the
// default ~/.config path is outside this PoC's writable sandbox.
const userDataDir = process.env.FLOWLET_ELECTRON_USER_DATA ?? path.join(HERE, ".electron-user-data");
mkdirSync(userDataDir, { recursive: true });
app.setPath("userData", userDataDir);
// No GPU on headless CI / xvfb: force software compositing so capturePage works.
app.disableHardwareAcceleration();

const screenshotArg = process.argv.find((arg) => arg.startsWith("--screenshot="));
const screenshotPath = screenshotArg
  ? path.resolve(screenshotArg.slice("--screenshot=".length))
  : null;
const adminToken = process.env.FLOWLET_ADMIN_TOKEN ?? "flowlet-poc-admin-token-0123456789";

// This environment's chrome-sandbox is not root:4755, and no user namespace is
// available; the PoC loads only a local loopback origin, so disable the sandbox
// for the shell. A production Electron port should ship a properly configured
// sandbox helper instead.
app.commandLine.appendSwitch("no-sandbox");
app.commandLine.appendSwitch("disable-gpu");

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  console.error("Flowlet PoC 已在运行（单实例锁）");
  app.exit(0);
} else {
  let serverHandle = null;
  let window = null;

  app.on("second-instance", () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.on("window-all-closed", () => app.quit());
  app.on("before-quit", () => serverHandle?.close());

  async function captureScreenshot(win, target) {
    // Wait until the React app has actually requested its data and rendered.
    const deadline = Date.now() + 20_000;
    let sawUi = false;
    while (Date.now() < deadline) {
      sawUi = await win.webContents.executeJavaScript(
        `document.body.innerText.includes("渠道账号") || document.body.innerText.includes("登录 Flowlet")`,
      );
      if (sawUi) break;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    await new Promise((resolve) => setTimeout(resolve, 1500)); // let queries settle
    const image = await win.webContents.capturePage();
    await writeFile(target, image.toPNG());
    console.log(`screenshot saved: ${target} (${image.getSize().width}x${image.getSize().height})`);
  }

  async function main() {
    serverHandle = await startServer();
    window = new BrowserWindow({
      width: 1280,
      height: 800,
      show: !screenshotPath,
      backgroundColor: "#0b0d12",
      title: "Flowlet (Electron PoC)",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: false },
    });

    // Desktop shell owns the local management credential: seed it into the
    // renderer's sessionStorage and reload — exactly what a user typing the
    // token into the Web Host login would produce. This also lets the window be
    // captured by an external X11 grabber when capturePage is unavailable.
    let seeded = false;
    window.webContents.on("console-message", (_event, level, message) => {
      console.log(`[renderer:${level}] ${message}`);
    });
    window.webContents.on("did-finish-load", async () => {
      try {
        if (!seeded) {
          seeded = true;
          await window.webContents.executeJavaScript(
            `sessionStorage.setItem("flowlet.web.admin-token", ${JSON.stringify(adminToken)}); location.reload();`,
          );
          return;
        }
        console.log("UI ready (commands answered)");
        if (process.env.FLOWLET_POC_DUMP) {
          await new Promise((r) => setTimeout(r, 8000));
          const text = await window.webContents.executeJavaScript("document.body.innerText");
          console.log("---- body text ----\n" + String(text).slice(0, 3000));
          app.exit(0);
        }
        if (screenshotPath) {
          await captureScreenshot(window, screenshotPath);
          app.exit(0);
        }
      } catch (error) {
        console.error("截图失败:", error);
        app.exit(1);
      }
    });
    window.webContents.on("did-fail-load", (_event, code, description, url) => {
      console.error("页面加载失败:", code, description, url);
      app.exit(1);
    });

    await window.loadURL(serverHandle.url);
    console.log(`Electron window loaded ${serverHandle.url}`);
  }

  app.whenReady().then(main).catch((error) => {
    console.error("Electron PoC 启动失败:", error);
    app.exit(1);
  });
}