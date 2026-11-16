import type { A2aCall } from "./types";

export function callOutcome(call: A2aCall): {
  label: string;
  tone: "success" | "danger" | "muted";
} {
  if (call.error || (call.httpStatus !== null && call.httpStatus >= 300))
    return { label: "请求失败", tone: "danger" };
  if (call.finishedAt === null) return { label: "请求中", tone: "muted" };
  if (
    call.httpStatus !== null &&
    call.httpStatus >= 200 &&
    call.httpStatus < 300
  )
    return { label: "请求成功", tone: "success" };
  return { label: "结果未知", tone: "muted" };
}
export function callMethodLabel(method: string): string {
  return (
    (
      {
        SendMessage: "发送消息",
        SendStreamingMessage: "流式消息",
        GetTask: "查询任务",
        ListTasks: "列出任务",
        CancelTask: "取消任务",
        SubscribeToTask: "订阅任务",
        "session/prompt": "发送消息",
        "session/cancel": "取消会话请求",
        "session/new": "创建会话",
        "session/load": "恢复会话",
        "session/set_config_option": "切换模型",
        "permission/reply": "回复远端权限询问",
        initialize: "初始化 ACP",
      } as Record<string, string>
    )[method] ?? method
  );
}
export function a2aStateLabel(state: string | null): string {
  const labels: Record<string, string> = {
    TASK_STATE_SUBMITTED: "已提交",
    TASK_STATE_WORKING: "处理中",
    TASK_STATE_INPUT_REQUIRED: "等待输入",
    TASK_STATE_COMPLETED: "已完成",
    TASK_STATE_CANCELED: "已取消",
    TASK_STATE_FAILED: "失败",
    TASK_STATE_REJECTED: "已拒绝",
    TASK_STATE_AUTH_REQUIRED: "需要授权",
  };
  return state ? (labels[state] ?? state) : "—";
}
