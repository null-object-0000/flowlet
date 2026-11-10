// 桌面账号工作区命令（批次 2）。Owner: desktop-maintenance。
//
// 负责：initialize_account_workspace / get_account_workspace_status /
// sync_account_workspace / export_desktop_account_workspace /
// import_desktop_account_workspace。
//
// 权威行为：src-tauri/src/commands/account_workspace.rs 与 core/account_workspace_sync.rs。
// 工作区密钥走宿主凭据库（channel `keyring.*`）的 service `Flowlet Account Workspace`；
// S3 访问经 `services/account-workspace.ts` + `services/s3.ts`（SigV4）。
// ChaCha20-Poly1305 的密钥长度、nonce、AAD 与信封格式不得变化。
//
// 与 Rust 的已知差异（非静默）：Rust 会为每次初始化/同步写 background_jobs 任务记录，
// Node 批次的 background job 存储由 observability 领域负责，这里暂不创建任务行，
// 但命令返回形状与业务结果一致。
import { CommandError } from "../types.ts";
import type { JsonRow } from "../types.ts";
import type { DesktopContext, DesktopHandlerMap } from "./types.ts";
import { argObject, argsObject, requireFields, serdeTypeName } from "../web/errors.ts";
import {
  exportDesktopPackage,
  importDesktopPackage,
  initialize,
  status,
  sync,
  type AccountWorkspaceContext,
  type DesktopAccountWorkspacePackage,
} from "../services/account-workspace.ts";

/** Rust `ACCOUNT_WORKSPACE_SYNC_GUARD`：进程内串行化初始化/同步/导入。 */
let queue: Promise<unknown> = Promise.resolve();

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function workspaceContext(ctx: DesktopContext): AccountWorkspaceContext {
  return { storage: ctx.storage, host: ctx.desktop.host };
}

/** Rust `refresh_accounts`：把数据库里的账号重新发布到运行时快照。 */
function refreshAccounts(ctx: DesktopContext): void {
  const accounts = ctx.storage.listChannelAccounts();
  ctx.runtimeConfig.update((draft) => {
    draft.accounts = accounts;
  });
}

function badRequest(error: unknown): CommandError {
  if (error instanceof CommandError) return error;
  return CommandError.badRequest(error instanceof Error ? error.message : String(error));
}

function packageFieldError(field: string, value: unknown, expected: string): CommandError {
  return CommandError.badRequest(
    `参数 package: field \`${field}\`: invalid type: ${serdeTypeName(value)}, expected ${expected}`,
  );
}

/** 校验 `DesktopAccountWorkspacePackage`（camelCase，secret 可缺省）。 */
function parseDesktopPackage(args: JsonRow): DesktopAccountWorkspacePackage {
  const pkg = argObject(args, "package", "DesktopAccountWorkspacePackage");
  requireFields(pkg, "package", ["format", "version", "s3", "accountWorkspaceKey"]);
  if (typeof pkg.format !== "string") {
    throw packageFieldError("format", pkg.format, "a string");
  }
  if (typeof pkg.version !== "number" || !Number.isInteger(pkg.version)) {
    throw packageFieldError("version", pkg.version, "u32");
  }
  if (typeof pkg.accountWorkspaceKey !== "string") {
    throw packageFieldError("accountWorkspaceKey", pkg.accountWorkspaceKey, "a string");
  }
  const s3 = argObject(pkg, "s3", "S3SyncConfigInput");
  requireFields(s3, "s3", ["endpoint", "region", "bucket", "prefix", "accessKeyId", "pathStyle"]);
  for (const field of ["endpoint", "region", "bucket", "prefix", "accessKeyId"]) {
    if (typeof s3[field] !== "string") {
      throw packageFieldError(`s3.${field}`, s3[field], "a string");
    }
  }
  if (typeof s3.pathStyle !== "boolean") {
    throw packageFieldError("s3.pathStyle", s3.pathStyle, "a boolean");
  }
  const secret = s3.secretAccessKey;
  if (secret !== null && secret !== undefined && typeof secret !== "string") {
    throw packageFieldError("s3.secretAccessKey", secret, "a string");
  }
  return {
    format: pkg.format,
    version: pkg.version,
    s3: {
      endpoint: s3.endpoint,
      region: s3.region,
      bucket: s3.bucket,
      prefix: s3.prefix,
      accessKeyId: s3.accessKeyId,
      secretAccessKey: typeof secret === "string" ? secret : null,
      pathStyle: s3.pathStyle,
    },
    accountWorkspaceKey: pkg.accountWorkspaceKey,
  };
}

export const handlers: DesktopHandlerMap = {
  get_account_workspace_status: async (ctx) => {
    try {
      return await status(workspaceContext(ctx));
    } catch (error) {
      throw badRequest(error);
    }
  },

  initialize_account_workspace: async (ctx) => {
    try {
      const result = await serialized(() => initialize(workspaceContext(ctx)));
      refreshAccounts(ctx);
      return result;
    } catch (error) {
      throw badRequest(error);
    }
  },

  sync_account_workspace: async (ctx) => {
    try {
      const result = await serialized(() => sync(workspaceContext(ctx)));
      refreshAccounts(ctx);
      return result;
    } catch (error) {
      throw badRequest(error);
    }
  },

  export_desktop_account_workspace: async (ctx) => {
    try {
      return await exportDesktopPackage(workspaceContext(ctx));
    } catch (error) {
      throw badRequest(error);
    }
  },

  import_desktop_account_workspace: async (ctx, rawArgs) => {
    const args = argsObject(rawArgs);
    const pkg = parseDesktopPackage(args);
    try {
      // Rust：import_desktop_package 成功后立即执行一次 sync，再刷新账号快照。
      const result = await serialized(async () => {
        await importDesktopPackage(workspaceContext(ctx), pkg);
        return sync(workspaceContext(ctx));
      });
      refreshAccounts(ctx);
      return result;
    } catch (error) {
      throw badRequest(error);
    }
  },
};
