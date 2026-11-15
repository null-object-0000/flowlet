import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { stopWindowsProcesses } from "./update-portable.mjs";

test("Windows 停止多个进程，并允许重复停止已退出的 PID", {
  skip: process.platform !== "win32",
}, async (t) => {
  const children = Array.from({ length: 2 }, () => spawn(process.execPath,
    ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" }));
  t.after(() => children.forEach((child) => child.kill()));
  await Promise.all(children.map((child) => once(child, "spawn")));
  const exits = children.map((child) => once(child, "exit"));
  const pids = children.map((child) => child.pid);
  assert.doesNotThrow(() => stopWindowsProcesses(pids));
  await Promise.all(exits);
  assert.doesNotThrow(() => stopWindowsProcesses(pids));
});

test("Windows 停止进程拒绝无效 PID", { skip: process.platform !== "win32" }, () => {
  for (const pid of [0, -1, NaN, "1; exit 0"]) {
    assert.throws(() => stopWindowsProcesses([pid]), /有效的 PID/);
  }
});
