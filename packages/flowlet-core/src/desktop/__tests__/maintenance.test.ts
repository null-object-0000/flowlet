// 桌面设置/维护命令（批次 2）契约测试。
//
// 覆盖：注册表、参数校验错误、返回形状（snake_case / camelCase / 元组）、
// config 导入导出 round-trip、autostart host channel 调用参数、存储维护命令。
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";

import { desktopCommandNames, dispatchDesktop } from "../commands.ts";
import {
  createTestContext,
  sampleAccount,
  samplePreset,
  samplePrice,
  sampleRoute,
  sampleRule,
  sampleVirtualModel,
  type TestContext,
} from "./support.ts";

const MAINTENANCE_COMMANDS = [
  "save_channel_presets",
  "list_route_rules",
  "save_route_rules",
  "read_config",
  "write_config",
  "export_config",
  "import_config",
  "analyze_usage",
  "account_stats",
  "db_stats",
  "storage_usage_summary",
  "compact_database",
  "cleanup_expired_body_data",
  "prune_oldest_body_data",
  "get_total_body_size_bytes",
  "get_app_version",
  "get_app_data_dir",
  "get_app_diagnostics",
  "log_from_frontend",
  "is_autostart_enabled",
  "enable_autostart",
  "disable_autostart",
];

const ACCOUNT_WORKSPACE_COMMANDS = [
  "initialize_account_workspace",
  "get_account_workspace_status",
  "sync_account_workspace",
  "export_desktop_account_workspace",
  "import_desktop_account_workspace",
];

let context: TestContext | null = null;

function makeContext(prefix?: string): TestContext {
  context = createTestContext({ prefix });
  return context;
}

afterEach(() => {
  context?.cleanup();
  context = null;
});

function rejectsWithStatus(promise: Promise<unknown>, status: number): Promise<boolean> {
  return promise.then(
    () => false,
    (error: unknown) => (error as { status?: number }).status === status,
  );
}

describe("桌面命令注册表", () => {
  it("27 条设置/维护/账号工作区命令全部注册", () => {
    const names = new Set(desktopCommandNames());
    for (const command of [...MAINTENANCE_COMMANDS, ...ACCOUNT_WORKSPACE_COMMANDS]) {
      assert.ok(names.has(command), `缺少桌面命令 ${command}`);
    }
  });
});

describe("应用信息与宿主能力", () => {
  it("get_app_version / get_app_data_dir 使用桌面运行时注入值", async () => {
    const t = makeContext();
    assert.equal(await dispatchDesktop(t.ctx, "get_app_version", {}), "9.9.9-test");
    assert.equal(await dispatchDesktop(t.ctx, "get_app_data_dir", {}), t.dir);
  });

  it("get_app_diagnostics 返回 Rust 同形 {os,database,proxy}", async () => {
    const t = makeContext();
    const stopped = (await dispatchDesktop(t.ctx, "get_app_diagnostics", {})) as {
      os: string;
      database: string;
      proxy: string;
    };
    assert.equal(stopped.database, "healthy");
    assert.equal(stopped.proxy, "stopped");
    assert.match(stopped.os, /^(linux|macos|windows) (x86_64|aarch64|x86)$/);
    t.setProxyRunning(true);
    const running = (await dispatchDesktop(t.ctx, "get_app_diagnostics", {})) as {
      proxy: string;
    };
    assert.equal(running.proxy, "running");
  });

  it("log_from_frontend 以 level/message 调用 platform.logFromFrontend", async () => {
    const t = makeContext();
    const result = await dispatchDesktop(t.ctx, "log_from_frontend", {
      level: "warn",
      message: "hello",
    });
    assert.equal(result, null);
    const call = t.host.calls.find((item) => item.channel === "platform.logFromFrontend");
    assert.deepEqual(call?.payload, { level: "warn", message: "hello" });
  });

  it("log_from_frontend 缺少参数时报 400", async () => {
    const t = makeContext();
    assert.ok(await rejectsWithStatus(dispatchDesktop(t.ctx, "log_from_frontend", { level: "warn" }), 400));
  });
});

describe("开机自启 host channel 契约", () => {
  it("is/enable/disable 调用 platform.autostart.* 并透传 enabled", async () => {
    const t = makeContext();
    t.host.respond("platform.autostart.get", () => ({ enabled: true }));
    assert.equal(await dispatchDesktop(t.ctx, "is_autostart_enabled", {}), true);
    assert.deepEqual(
      t.host.calls.find((item) => item.channel === "platform.autostart.get")?.payload,
      {},
    );

    assert.equal(await dispatchDesktop(t.ctx, "enable_autostart", {}), null);
    assert.deepEqual(
      t.host.calls.filter((item) => item.channel === "platform.autostart.set").at(-1)?.payload,
      { enabled: true },
    );

    assert.equal(await dispatchDesktop(t.ctx, "disable_autostart", {}), null);
    assert.deepEqual(
      t.host.calls.filter((item) => item.channel === "platform.autostart.set").at(-1)?.payload,
      { enabled: false },
    );
  });

  it("自启失败时使用 Rust 错误前缀", async () => {
    const t = makeContext();
    t.host.respond("platform.autostart.get", () => {
      throw new Error("boom");
    });
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "is_autostart_enabled", {}),
      (error: unknown) =>
        (error as { message?: string }).message === "检查自启动状态失败: boom",
    );
    t.host.respond("platform.autostart.set", () => {
      throw new Error("denied");
    });
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "enable_autostart", {}),
      (error: unknown) => (error as { message?: string }).message === "启用自启动失败: denied",
    );
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "disable_autostart", {}),
      (error: unknown) => (error as { message?: string }).message === "禁用自启动失败: denied",
    );
  });
});

describe("config.json 读写", () => {
  it("write_config 校验 JSON 后原样写入，read_config 读回原文", async () => {
    const t = makeContext();
    const content = '{"channels_config":{"channels":[]}}';
    assert.equal(await dispatchDesktop(t.ctx, "write_config", { content }), null);
    assert.equal(readFileSync(t.configPath, "utf8"), content);
    assert.equal(await dispatchDesktop(t.ctx, "read_config", {}), content);
  });

  it("read_config 在文件缺失时返回 Rust 文案", async () => {
    const t = makeContext();
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "read_config", {}),
      (error: unknown) =>
        (error as { message?: string }).message === "config.json 不存在或读取失败",
    );
  });

  it("write_config 拒绝非法 JSON 与非对象顶层", async () => {
    const t = makeContext();
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "write_config", { content: "{" }),
      (error: unknown) => String((error as { message?: string }).message).startsWith("JSON 解析失败:"),
    );
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "write_config", { content: "123" }),
      (error: unknown) =>
        (error as { message?: string }).message === "config.json 顶层必须是对象或数组",
    );
    assert.ok(await rejectsWithStatus(dispatchDesktop(t.ctx, "write_config", {}), 400));
  });
});

describe("渠道预设与路由规则", () => {
  it("save_channel_presets 保存后发布运行时快照", async () => {
    const t = makeContext();
    const presets = [samplePreset()];
    assert.equal(await dispatchDesktop(t.ctx, "save_channel_presets", { presets }), null);
    assert.equal(t.storage.listChannelPresets().length, 1);
    assert.deepEqual(t.runtimeConfig.snapshot().channels, presets);
  });

  it("save_channel_presets 缺少必填字段时报 400", async () => {
    const t = makeContext();
    const broken = [{ id: "x", name: "X" }];
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "save_channel_presets", { presets: broken }),
      (error: unknown) =>
        String((error as { message?: string }).message).includes(
          "参数 presets: missing field `vendor`",
        ),
    );
  });

  it("save_route_rules 全量替换并可通过 list_route_rules 读回", async () => {
    const t = makeContext();
    const rules = [sampleRule("rule-a"), sampleRule("rule-b")];
    assert.equal(await dispatchDesktop(t.ctx, "save_route_rules", { rules }), null);
    assert.equal(t.storage.listRouteRules().length, 2);
    assert.deepEqual(await dispatchDesktop(t.ctx, "list_route_rules", {}), rules);
    // 幂等：再次写入同样的规则不会追加。
    await dispatchDesktop(t.ctx, "save_route_rules", { rules });
    assert.equal(t.storage.listRouteRules().length, 2);
  });

  it("save_route_rules 缺少必填字段时报 400", async () => {
    const t = makeContext();
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "save_route_rules", { rules: [{ id: "r" }] }),
      (error: unknown) =>
        String((error as { message?: string }).message).includes(
          "参数 rules: missing field `name`",
        ),
    );
  });
});

describe("config 导入导出 round-trip", () => {
  it("export_config → import_config 恢复配置、价格与运行时快照", async () => {
    const t = makeContext();
    t.storage.saveChannelPresets([samplePreset()]);
    t.storage.saveChannelAccounts([sampleAccount()]);
    t.storage.saveRouteCandidates([sampleRoute()]);
    t.storage.saveRouteRules([sampleRule()]);
    t.storage.saveVirtualModels([sampleVirtualModel()]);
    t.storage.setPrices([samplePrice()]);

    const exported = (await dispatchDesktop(t.ctx, "export_config", {})) as string;
    const bundle = JSON.parse(exported) as Record<string, unknown>;
    assert.equal(bundle.version, "1");
    assert.equal(typeof bundle.exported_at, "string");
    assert.equal((bundle.channels as unknown[]).length, 1);
    assert.equal((bundle.accounts as unknown[]).length, 1);
    assert.equal((bundle.routes as unknown[]).length, 1);
    assert.equal((bundle.rules as unknown[]).length, 1);
    assert.equal((bundle.prices as unknown[]).length, 1);
    assert.equal((bundle.virtual_models as unknown[]).length, 1);

    // 清空后再导入，验证完整恢复。
    t.storage.saveChannelPresets([]);
    t.storage.saveChannelAccounts([]);
    t.storage.saveRouteCandidates([]);
    t.storage.saveRouteRules([]);
    t.storage.saveVirtualModels([]);
    t.storage.setPrices([]);
    t.runtimeConfig.replace({
      channels: [],
      accounts: [],
      routes: [],
      rules: [],
      virtual_models: [],
    });

    assert.equal(await dispatchDesktop(t.ctx, "import_config", { json: exported }), null);
    assert.equal(t.storage.listChannelPresets().length, 1);
    assert.equal(t.storage.listChannelAccounts().length, 1);
    assert.equal(t.storage.listRouteCandidates().length, 1);
    assert.equal(t.storage.listRouteRules().length, 1);
    assert.equal(t.storage.listVirtualModels().length, 1);
    assert.equal(t.storage.prices().length, 1);
    const snapshot = t.runtimeConfig.snapshot();
    assert.equal((snapshot.accounts as unknown[]).length, 1);
    assert.equal((snapshot.channels as unknown[]).length, 1);
  });

  it("import_config 拒绝非法 JSON 与缺少 bundle 字段", async () => {
    const t = makeContext();
    await assert.rejects(() => dispatchDesktop(t.ctx, "import_config", { json: "{" }), (error: unknown) => {
      return (error as { status?: number }).status === 400;
    });
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "import_config", { json: "{}" }),
      (error: unknown) =>
        String((error as { message?: string }).message).includes(
          "参数 json: missing field `version`",
        ),
    );
  });
});

describe("存储维护", () => {
  it("db_stats 返回 [日志数, 用量行数, 数据库字节]", async () => {
    const t = makeContext();
    const stats = (await dispatchDesktop(t.ctx, "db_stats", {})) as number[];
    assert.equal(stats.length, 3);
    assert.equal(stats[0], 0);
    assert.equal(stats[1], 0);
    assert.ok(stats[2] > 0, "新建库也应有 page_count * page_size");
  });

  it("storage_usage_summary 返回 camelCase 分类且计入 config.json 大小", async () => {
    const t = makeContext();
    writeFileSync(t.configPath, "x".repeat(128));
    const summary = (await dispatchDesktop(t.ctx, "storage_usage_summary", {
      scanId: "scan-1",
    })) as Record<string, unknown>;
    assert.equal(summary.configBytes, 128);
    assert.equal(typeof summary.totalBytes, "number");
    assert.equal(typeof summary.databaseBytes, "number");
    assert.equal(typeof summary.reclaimableBytes, "number");
    assert.equal(typeof summary.autoVacuumMode, "number");
    assert.equal(typeof summary.walBytes, "number");
    assert.equal(typeof summary.sharedMemoryBytes, "number");
    assert.equal(typeof summary.captureBytes, "number");
    assert.equal(typeof summary.categorizedBytes, "number");
    const categories = summary.categories as Array<Record<string, unknown>>;
    const keys = categories.map((category) => category.key);
    for (const expected of [
      "configuration",
      "requestLogs",
      "usage",
      "agentSessions",
      "backgroundTasks",
      "requestCaptures",
    ]) {
      assert.ok(keys.includes(expected), `缺少分类 ${expected}`);
    }
    for (const category of categories) {
      assert.deepEqual(Object.keys(category).sort(), ["allocatedBytes", "key", "rowCount"]);
    }
  });

  it("storage_usage_summary 缺少 scanId 时报 400", async () => {
    const t = makeContext();
    assert.ok(await rejectsWithStatus(dispatchDesktop(t.ctx, "storage_usage_summary", {}), 400));
  });

  it("compact_database 返回 camelCase 压缩结果，代理运行时拒绝", async () => {
    const t = makeContext();
    t.setProxyRunning(true);
    await assert.rejects(
      () => dispatchDesktop(t.ctx, "compact_database", {}),
      (error: unknown) =>
        (error as { message?: string }).message === "优化数据库前必须先暂停代理服务",
    );
    t.setProxyRunning(false);
    const result = (await dispatchDesktop(t.ctx, "compact_database", {})) as Record<string, unknown>;
    assert.deepEqual(Object.keys(result).sort(), ["after", "before", "reclaimedBytes"]);
    for (const side of ["before", "after"]) {
      const stats = result[side] as Record<string, unknown>;
      assert.deepEqual(Object.keys(stats).sort(), [
        "autoVacuumMode",
        "databaseBytes",
        "freelistCount",
        "pageCount",
        "pageSize",
        "reclaimableBytes",
      ]);
      // VACUUM 后应已切到增量 auto-vacuum（2 = INCREMENTAL）。
      if (side === "after") assert.equal(stats.autoVacuumMode, 2);
    }
    assert.ok((result.reclaimedBytes as number) >= 0);
  });

  it("body 数据维护命令在空库返回 0，并校验参数", async () => {
    const t = makeContext();
    assert.equal(await dispatchDesktop(t.ctx, "get_total_body_size_bytes", {}), 0);
    assert.equal(
      await dispatchDesktop(t.ctx, "cleanup_expired_body_data", { retentionDays: 7 }),
      0,
    );
    assert.equal(
      await dispatchDesktop(t.ctx, "prune_oldest_body_data", {
        targetBytes: 1024,
        pruneRatio: 0.5,
      }),
      0,
    );
    assert.ok(
      await rejectsWithStatus(dispatchDesktop(t.ctx, "cleanup_expired_body_data", {}), 400),
    );
    assert.ok(
      await rejectsWithStatus(
        dispatchDesktop(t.ctx, "prune_oldest_body_data", { targetBytes: 1024 }),
        400,
      ),
    );
  });

  it("analyze_usage 返回重解析 + 补齐的数量总和", async () => {
    const t = makeContext();
    const analyzed = await dispatchDesktop(t.ctx, "analyze_usage", {});
    assert.equal(typeof analyzed, "number");
    assert.ok((analyzed as number) >= 0);
  });

  it("account_stats 返回数组", async () => {
    const t = makeContext();
    assert.deepEqual(await dispatchDesktop(t.ctx, "account_stats", {}), []);
  });
});