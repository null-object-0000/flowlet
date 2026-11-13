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
  return state ? (labels[state] ?? state) : "未返回任务状态";
}
