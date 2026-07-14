import React from "react";
import { Alert, Button, Modal, Radio, Stack, Text, TextInput } from "@mantine/core";
import { IconAlertCircle, IconTrash } from "@tabler/icons-react";

const TIERS: Array<{ value: string; label: string; keepDays: number | null }> = [
  { value: "all", label: "全部日志", keepDays: 0 },
  { value: "7", label: "保留最近 7 天", keepDays: 7 },
  { value: "30", label: "保留最近 30 天", keepDays: 30 },
  { value: "90", label: "保留最近 90 天", keepDays: 90 },
  { value: "custom", label: "自定义", keepDays: null },
];

export function ClearLogsModal({
  opened,
  onClose,
  onConfirm,
  totalLogs,
}: {
  opened: boolean;
  onClose: () => void;
  onConfirm: (keepDays: number) => void;
  totalLogs: number;
}) {
  const [tier, setTier] = React.useState<string>("all");
  const [customDays, setCustomDays] = React.useState<string>("7");
  const [confirming, setConfirming] = React.useState(false);

  // 弹窗打开时重置档位与确认态，避免带走上一次的临时选择
  React.useEffect(() => {
    if (opened) {
      setTier("all");
      setCustomDays("7");
      setConfirming(false);
    }
  }, [opened]);

  const customNum = Number(customDays);
  const customValid = Number.isFinite(customNum) && customNum > 0 && Number.isInteger(customNum);

  const keepDays =
    tier === "custom" ? (customValid ? customNum : null) : TIERS.find((t) => t.value === tier)?.keepDays ?? 0;

  const confirmDisabled = totalLogs === 0 || keepDays === null;

  const tierLabel =
    keepDays === 0 ? "全部日志" : keepDays != null ? TIERS.find((t) => t.keepDays === keepDays)?.label ?? `${keepDays} 天` : "—";

  function handleFirstConfirm() {
    if (confirmDisabled) return;
    setConfirming(true);
  }

  function handleFinalConfirm() {
    if (keepDays == null) return;
    onConfirm(keepDays);
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={confirming ? "再次确认清除范围" : "清除请求日志"}
      size="min(480px, 92vw)"
      padding="md"
      zIndex={2000}
    >
      <Stack gap="md">
        {confirming ? (
          <>
            <Text size="sm">
              即将清除 <strong>{tierLabel}</strong> 的请求日志与用量统计（当前共 <strong>{totalLogs}</strong> 条）。
            </Text>
            <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
              此操作不可恢复，清除后数据将被永久删除。
            </Alert>
          </>
        ) : (
          <>
            <Text size="sm" c="dimmed">
              当前共 <strong>{totalLogs}</strong> 条请求日志。选择保留范围：
            </Text>

            <Radio.Group value={tier} onChange={setTier}>
              <Stack gap="xs">
                {TIERS.map((t) => (
                  <div key={t.value}>
                    <Radio value={t.value} label={t.label} disabled={t.value !== "custom" && totalLogs === 0} />
                    {t.value === "custom" && tier === "custom" ? (
                      <TextInput
                        type="number"
                        min={1}
                        step={1}
                        placeholder="输入保留天数"
                        value={customDays}
                        onChange={(e) => setCustomDays(e.currentTarget.value)}
                        w={160}
                        mt="xs"
                        ml={28}
                        error={!customValid ? "请输入正整数" : null}
                      />
                    ) : null}
                  </div>
                ))}
              </Stack>
            </Radio.Group>

            {totalLogs > 0 ? (
              <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">
                清除后不可恢复，同步删除请求日志与用量统计。
              </Alert>
            ) : (
              <Alert color="blue" variant="light">暂无可清除的日志。</Alert>
            )}
          </>
        )}

        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="subtle" onClick={confirming ? () => setConfirming(false) : onClose}>
            {confirming ? "返回" : "取消"}
          </Button>
          <Button
            color="red"
            leftSection={<IconTrash size={15} />}
            disabled={confirmDisabled}
            onClick={confirming ? handleFinalConfirm : handleFirstConfirm}
          >
            {confirming ? "永久清除" : "确认清除"}
          </Button>
        </div>
      </Stack>
    </Modal>
  );
}
