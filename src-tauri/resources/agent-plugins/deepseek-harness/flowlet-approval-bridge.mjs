import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

/**
 * Flowlet 交互确认桥：把 DSH headless 会话的 approval/request 转交本地
 * Flowlet 桌面端确认或否决（文件桥协议，与 OpenCode 权限桥同构）。
 *
 * 插件作为 `approval/request` 瀑布的一个 answerer：收到请求后把参数
 * （toolName / callId / reason / DSH 会话 id）原子写入
 * `~/.flowlet/dsh-control/request-<uuid>.json`，并在等待期间每秒刷新
 * heartbeatAt（Flowlet 端按心跳新鲜度过滤 pending）。用户决定后 Flowlet
 * 写入 `reply-<uuid>.json`，插件轮询读回并换算为 DSH 的
 * `allowed-once` / `rejected` 结果结束瀑布。
 *
 * 生命周期对齐 DSH ApprovalService：请求被取消（signal abort）时清理文件并
 * 返回 `cancelled`；超过 timeoutMs 无人应答时清理文件并返回 `unavailable`
 * （与无人应答的 fail-closed 语义一致，避免 Flowlet 未运行时任务永久挂起）。
 * 插件只与自己创建的 uuid 文件交互，服务重启后由 Flowlet 端按心跳新鲜度
 * 丢弃孤儿请求，不会误删其它实例的文件。
 *
 * 该插件为显式开启的高级能力：由 Flowlet 作为受管文件部署到用户选定的
 * DSH Profile（`# flowlet-managed:start deepseek-harness-approval-bridge` 块），
 * 随备份/恢复原子写入，不修改 DSH npm 包与缓存。
 *
 * @param ctx - Cordis 上下文。
 * @param config - `{ provider: "flowlet", timeoutMs?: number }`。
 */
export default function apply(ctx, config = {}) {
  const provider = config.provider ?? "flowlet";
  const timeoutMs = Number.isFinite(config.timeoutMs) ? config.timeoutMs : 10 * 60 * 1000;
  const controlDir = join(homedir(), ".flowlet", "dsh-control");

  /** 原子写 JSON 文件：先写同目录 `.tmp` 再 rename，避免 Flowlet 读到半截内容。 */
  function writeJson(file, value) {
    mkdirSync(controlDir, { recursive: true });
    const temp = `${file}.tmp`;
    writeFileSync(temp, JSON.stringify(value));
    renameSync(temp, file);
  }

  /** 删除请求与回复文件；不存在时静默。 */
  function cleanup(approvalId) {
    for (const file of [`request-${approvalId}.json`, `reply-${approvalId}.json`]) {
      try {
        rmSync(join(controlDir, file), { force: true });
      } catch {
        // 删除失败不影响瀑布结果；Flowlet 端新鲜度会自行丢弃残留。
      }
    }
  }

  /** 读取 Flowlet 的回复；为空、损坏或与本次请求不符时返回 undefined。 */
  function readReply(approvalId) {
    try {
      const parsed = JSON.parse(readFileSync(join(controlDir, `reply-${approvalId}.json`), "utf8"));
      if (parsed?.approvalId !== approvalId) return undefined;
      if (parsed.reply === "allow-once") return "allowed-once";
      if (parsed.reply === "reject") return "rejected";
      return undefined;
    } catch {
      return undefined;
    }
  }

  ctx.on("approval/request", (request, next) => {
    const agent = request.agent;
    if (agent === undefined || agent.session?.id === undefined) return next();
    const approvalId = randomUUID();
    const requestedAt = Date.now();
    writeJson(join(controlDir, `request-${approvalId}.json`), {
      approvalId,
      sessionId: String(agent.session.id),
      toolName: request.toolName ?? "unknown",
      callId: request.callId ?? null,
      reason: request.reason ?? null,
      provider,
      requestedAt,
      heartbeatAt: requestedAt,
      bridgeVersion: 1,
    });

    const requestBody = () => ({
      approvalId,
      sessionId: String(agent.session.id),
      toolName: request.toolName ?? "unknown",
      callId: request.callId ?? null,
      reason: request.reason ?? null,
      provider,
      requestedAt,
      heartbeatAt: Date.now(),
      bridgeVersion: 1,
    });
    return new Promise((resolve) => {
      let settled = false;
      const settle = (outcome) => {
        if (settled) return;
        settled = true;
        clearInterval(heartbeat);
        clearInterval(poll);
        cleanup(approvalId);
        resolve(outcome);
      };
      // 每秒刷新 heartbeatAt，让 Flowlet 端始终能看到这是活跃等待中的确认请求。
      const heartbeat = setInterval(() => {
        try {
          writeJson(join(controlDir, `request-${approvalId}.json`), requestBody());
        } catch {
          // 目录或文件暂时不可写时跳过本轮；下一次心跳继续尝试。
        }
      }, 1000);
      const poll = setInterval(() => {
        const outcome = readReply(approvalId);
        if (outcome !== undefined) settle(outcome);
      }, 80);
      request.signal?.addEventListener?.("abort", () => settle("cancelled"), { once: true });
      setTimeout(() => settle("unavailable"), timeoutMs);
    });
  });
}