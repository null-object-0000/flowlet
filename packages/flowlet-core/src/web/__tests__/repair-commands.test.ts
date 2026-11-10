// 数据完整性检查四阶段在 Web Host 命令层的接线契约。
//
// 前端 `src/domains/data-repair/commands.ts` 通过 Tauri command 名调用：
// repair_agent_sessions / repair_captured_usage / repair_unknown_usage / repair_usage_costs，
// 参数均按 camelCase `timeRange` 传递。这里只验证 dispatch 路由、参数解析和 ua_rules 加载，
// 不重复存储层修复语义（见 storage/__tests__/repair.test.ts）。
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { dispatch } from "../commands.ts";
import type { WebContext } from "../context.ts";

interface Call {
  command: string;
  timeRange: string;
  uaRules: unknown;
}

function makeContext(dir: string, calls: Call[]): WebContext {
  const storage = {
    repairAgentSessions(timeRange: string, uaRules: unknown) {
      calls.push({ command: "sessions", timeRange, uaRules });
      return {
        scannedRequests: 2,
        repairedRequests: 1,
        repairedLogs: 1,
        skippedRequests: 1,
        repairedClients: 0,
      };
    },
    repairCapturedUsage(timeRange: string) {
      calls.push({ command: "captured", timeRange, uaRules: null });
      return 3;
    },
    repairUnknownUsage(timeRange: string) {
      calls.push({ command: "unknown", timeRange, uaRules: null });
      return 4;
    },
    repairUsageCosts(timeRange: string) {
      calls.push({ command: "costs", timeRange, uaRules: null });
      return 5;
    },
  };
  return {
    storage,
    configPath: path.join(dir, "config.json"),
    config: { ua_rules: [{ id: "custom", name: "Custom", ua_contains: ["custom-agent/"] }] },
  } as unknown as WebContext;
}

test("四种修复命令按 camelCase timeRange 路由到存储层", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-repair-cmd-"));
  const calls: Call[] = [];
  const ctx = makeContext(dir, calls);
  writeFileSync(
    path.join(dir, "config.json"),
    JSON.stringify({ ua_rules: [{ id: "custom", name: "Custom", ua_contains: ["custom-agent/"] }] }),
  );
  try {
    assert.deepEqual(await dispatch(ctx, "repair_agent_sessions", { timeRange: "all" }), {
      scannedRequests: 2,
      repairedRequests: 1,
      repairedLogs: 1,
      skippedRequests: 1,
      repairedClients: 0,
    });
    assert.equal(await dispatch(ctx, "repair_captured_usage", { timeRange: "7d" }), 3);
    assert.equal(await dispatch(ctx, "repair_unknown_usage", { timeRange: "today" }), 4);
    assert.equal(await dispatch(ctx, "repair_usage_costs", { timeRange: "1h" }), 5);

    assert.deepEqual(
      calls.map((call) => [call.command, call.timeRange]),
      [
        ["sessions", "all"],
        ["captured", "7d"],
        ["unknown", "today"],
        ["costs", "1h"],
      ],
    );
    // ua_rules 来自 ctx.configPath 的 config.json（含自定义规则 + 内置规则）。
    const rules = calls[0].uaRules as { id: string }[];
    assert.ok(rules.some((rule) => rule.id === "custom"), "必须加载 config.json 的自定义 UA 规则");
    assert.ok(rules.length > 1, "应当合并内置 UA 规则");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺少 timeRange 时返回参数错误", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-repair-cmd-"));
  const ctx = makeContext(dir, []);
  writeFileSync(path.join(dir, "config.json"), "{}");
  try {
    await assert.rejects(
      () => dispatch(ctx, "repair_captured_usage", {}),
      (error: unknown) => {
        const status = (error as { status?: number }).status;
        return status === 400;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});