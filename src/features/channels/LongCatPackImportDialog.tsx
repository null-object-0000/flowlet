import React from "react";
import { ActionIcon, Alert, Button, Modal, Stack, Table, Text, TextInput } from "@mantine/core";
import { IconAlertCircle, IconPlus, IconTrash } from "@tabler/icons-react";

export type LongCatLot = {
  lotId?: number;
  totalToken?: number;
  consumedToken?: number;
  remainingToken?: number;
  expireTime?: string;
  status?: string;
  source?: string;
  grantCategory?: string;
};

type LongCatPackManagerProps = {
  opened: boolean;
  onClose: () => void;
  onSave: (lots: LongCatLot[]) => void;
  initialLots?: LongCatLot[];
};

function parseLongCatResponse(text: string): LongCatLot[] {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("请输入 LongCat /token-packs/summary 接口返回的 JSON 数据");

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error("JSON 解析失败，请检查粘贴内容是否完整");
  }

  // 兼容外层包了 { code, msg, data } 结构。
  const dataField = (parsed as { data?: Record<string, unknown> })?.data ?? (parsed as Record<string, unknown>);
  if (!dataField || typeof dataField !== "object") {
    throw new Error("未找到 data 字段，请确认接口响应格式正确");
  }

  const data = dataField as Record<string, unknown>;
  const currentLot = data.currentLot as LongCatLot | undefined;
  const otherLots = (data.otherLots as LongCatLot[] | undefined) ?? [];

  const lots: LongCatLot[] = [];
  if (currentLot && typeof currentLot === "object") lots.push(currentLot);
  for (const lot of otherLots) {
    if (lot && typeof lot === "object" && !lots.some((item) => item.lotId === lot.lotId)) lots.push(lot);
  }

  if (lots.length === 0) throw new Error("未找到任何资源包（currentLot 和 otherLots 均为空）");

  return lots;
}

export function formatLongCatTime(value?: string): string {
  if (!value) return "-";
  return value.replace("T", " ").slice(0, 16);
}

export function formatTokenCount(value: number | null | undefined): string {
  if (value == null) return "-";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

/// 优先消耗最快过期的资源包：按到期时间升序排列（null/未知排最后）
function sortLotsByPriority(lots: LongCatLot[]): LongCatLot[] {
  return [...lots].sort((a, b) => {
    if (!a.expireTime && !b.expireTime) return 0;
    if (!a.expireTime) return 1;
    if (!b.expireTime) return -1;
    return a.expireTime < b.expireTime ? -1 : a.expireTime > b.expireTime ? 1 : 0;
  });
}

/// 计算资源包汇总
export function summarizeLots(lots: LongCatLot[]): {
  total: number;
  used: number;
  remaining: number;
  expireAt: string | null;
} {
  const active = lots.filter((lot) => !lot.status || lot.status === "ACTIVE");
  const target = active.length > 0 ? active : lots;

  let total = 0;
  let used = 0;
  let remaining = 0;
  let expireAt: string | null = null;

  for (const lot of target) {
    total += lot.totalToken ?? 0;
    used += lot.consumedToken ?? 0;
    remaining += lot.remainingToken ?? 0;
    if (lot.expireTime && (!expireAt || lot.expireTime < expireAt)) {
      expireAt = lot.expireTime;
    }
  }

  return { total, used, remaining, expireAt };
}

function formatDateInput(value?: string): string {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "";
  const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 10);
}

let nextLocalId = -1;
function newLocalId(): number {
  nextLocalId -= 1;
  return nextLocalId;
}

export function LongCatPackManager({ opened, onClose, onSave, initialLots = [] }: LongCatPackManagerProps) {
  const [lots, setLots] = React.useState<LongCatLot[]>(() => sortLotsByPriority(initialLots));
  const [json, setJson] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // 当弹窗打开时重置数据
  React.useEffect(() => {
    if (opened) {
      setLots(sortLotsByPriority(initialLots));
      setJson("");
      setError(null);
    }
  }, [opened, initialLots]);

  function handleAddPack() {
    setLots((current) => sortLotsByPriority([...current, { lotId: newLocalId(), status: "ACTIVE" }]));
  }

  function handleImportJson() {
    try {
      const imported = parseLongCatResponse(json);
      setError(null);
      // 合并：相同 lotId 的覆盖，新增的追加
      setLots((current) => {
        const map = new Map<number, LongCatLot>();
        for (const lot of current) {
          if (lot.lotId != null) map.set(lot.lotId, lot);
        }
        for (const lot of imported) {
          if (lot.lotId != null) map.set(lot.lotId, lot);
        }
        return sortLotsByPriority(Array.from(map.values()));
      });
      setJson("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function handleUpdateLot(index: number, patch: Partial<LongCatLot>) {
    setLots((current) => sortLotsByPriority(current.map((lot, i) => (i === index ? { ...lot, ...patch } : lot))));
  }

  function handleDeleteLot(index: number) {
    setLots((current) => sortLotsByPriority(current.filter((_, i) => i !== index)));
  }

  function handleSave() {
    onSave(lots);
    onClose();
  }

  function handleClose() {
    setJson("");
    setError(null);
    onClose();
  }

  const summary = summarizeLots(lots);

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="LongCat 资源包管理"
      size="min(900px, 96vw)"
      padding="md"
      zIndex={2000}
      classNames={{ root: "longcat-pack-manager-dialog" }}
    >
      <Stack gap="md">
        {/* 导入 JSON 区域 */}
        <Text size="sm" c="dimmed">
          在浏览器中登录 LongCat，打开 F12 开发者工具，请求 <code>/api/pay/quota/metering/token-packs/summary</code> 后，
          将响应 JSON 粘贴到下方导入（自动合并相同 ID 的资源包）：
        </Text>
        <TextInput
          placeholder='{"code":0,"msg":"success","data":{"currentLot":{...},"otherLots":[...]}}'
          value={json}
          onChange={(event) => {
            setJson(event.currentTarget.value);
            setError(null);
          }}
          error={error}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <Button variant="light" size="xs" disabled={!json.trim()} onClick={handleImportJson}>
            导入 JSON
          </Button>
          <Button variant="subtle" size="xs" leftSection={<IconPlus size={13} />} onClick={handleAddPack}>
            添加资源包
          </Button>
        </div>

        {error ? (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">{error}</Alert>
        ) : null}

        {/* 资源包表格 */}
        {lots.length > 0 ? (
          <Table striped highlightOnHover withTableBorder withColumnBorders className="longcat-pack-edit-table">
            <Table.Thead>
              <Table.Tr>
                <Table.Th w={40}>#</Table.Th>
                <Table.Th w={120}>总量</Table.Th>
                <Table.Th w={120}>已消耗</Table.Th>
                <Table.Th w={120}>剩余</Table.Th>
                <Table.Th w={140}>到期时间</Table.Th>
                <Table.Th w={90}>状态</Table.Th>
                <Table.Th w={50}>操作</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {lots.map((lot, index) => (
                <Table.Tr key={lot.lotId ?? `new-${index}`}>
                  <Table.Td>{index + 1}</Table.Td>
                  <Table.Td>
                    <TextInput
                      type="number"
                      min={0}
                      size="xs"
                      value={lot.totalToken ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        handleUpdateLot(index, { totalToken: value === "" ? undefined : Number(value) });
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      type="number"
                      min={0}
                      size="xs"
                      value={lot.consumedToken ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        handleUpdateLot(index, { consumedToken: value === "" ? undefined : Number(value) });
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      type="number"
                      min={0}
                      size="xs"
                      value={lot.remainingToken ?? ""}
                      onChange={(event) => {
                        const value = event.target.value;
                        handleUpdateLot(index, { remainingToken: value === "" ? undefined : Number(value) });
                      }}
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      type="date"
                      size="xs"
                      value={formatDateInput(lot.expireTime)}
                      onChange={(event) => handleUpdateLot(index, { expireTime: event.target.value ? new Date(`${event.target.value}T23:59:59`).toISOString() : undefined })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <TextInput
                      size="xs"
                      placeholder="ACTIVE"
                      value={lot.status ?? ""}
                      onChange={(event) => handleUpdateLot(index, { status: event.target.value || undefined })}
                    />
                  </Table.Td>
                  <Table.Td>
                    <ActionIcon variant="subtle" color="red" size="sm" onClick={() => handleDeleteLot(index)}>
                      <IconTrash size={14} />
                    </ActionIcon>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        ) : (
          <Alert color="blue" variant="light">暂无资源包，请导入 JSON 或手动添加。</Alert>
        )}

        {/* 汇总信息 */}
        {lots.length > 0 ? (
          <div className="longcat-packs-summary">
            <span>总量 <strong>{formatTokenCount(summary.total)}</strong></span>
            <span>已消耗 <strong>{formatTokenCount(summary.used)}</strong></span>
            <span>剩余 <strong>{formatTokenCount(summary.remaining)}</strong></span>
            <span>最早到期 <strong>{summary.expireAt ? formatLongCatTime(summary.expireAt) : "-"}</strong></span>
          </div>
        ) : null}

        {/* 操作按钮 */}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button variant="subtle" onClick={handleClose}>取消</Button>
          <Button onClick={handleSave} disabled={lots.length === 0}>保存</Button>
        </div>
      </Stack>
    </Modal>
  );
}

// 兼容旧导出名
export { LongCatPackManager as LongCatPackImportDialog };

// 解析快照存储的 token_packs JSON。
export function parseSnapshotTokenPacks(value?: string | null): LongCatLot[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) return parsed as LongCatLot[];
    return [];
  } catch {
    return [];
  }
}
