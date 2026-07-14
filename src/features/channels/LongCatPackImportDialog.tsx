import React from "react";
import { Alert, Button, Modal, Stack, Table, Text, Textarea, TextInput } from "@mantine/core";
import { IconAlertCircle, IconUpload } from "@tabler/icons-react";

type LongCatLot = {
  lotId?: number;
  grantCategory?: string;
  source?: string;
  bizOrderNo?: string;
  remainingToken?: number;
  consumedToken?: number;
  frozenToken?: number;
  totalToken?: number;
  consumedRatio?: number;
  effectiveTime?: string;
  expireTime?: string;
  remainSeconds?: number;
  consumeOrder?: number;
  status?: string;
};

type ParsedResult = {
  lots: LongCatLot[];
  raw: Record<string, unknown>;
};

type LongCatPackImportDialogProps = {
  opened: boolean;
  onClose: () => void;
  onImport: (lots: LongCatLot[]) => void;
};

function parseLongCatResponse(text: string): ParsedResult {
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

  return { lots, raw: data };
}

function formatLongCatTime(value?: string): string {
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

export function LongCatPackImportDialog({ opened, onClose, onImport }: LongCatPackImportDialogProps) {
  const [json, setJson] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ParsedResult | null>(null);

  function handleParse() {
    try {
      const result = parseLongCatResponse(json);
      setError(null);
      setPreview(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setPreview(null);
    }
  }

  function handleImport() {
    if (!preview) return;
    // 按到期时间升序传入，保证优先消耗最快过期的资源包
    onImport(sortLotsByPriority(preview.lots));
    handleClose();
  }

  function handleClose() {
    setJson("");
    setError(null);
    setPreview(null);
    onClose();
  }

  return (
    <Modal
      opened={opened}
      onClose={handleClose}
      title="导入 LongCat 资源包"
      size="min(720px, 96vw)"
      padding="md"
      zIndex={2000}
      classNames={{ root: "longcat-pack-import-dialog" }}
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          在浏览器中登录 LongCat，打开 F12 开发者工具，请求 <code>/api/pay/quota/metering/token-packs/summary</code> 后，
          将响应 JSON 粘贴到下方：
        </Text>
        <Textarea
          placeholder='{"code":0,"msg":"success","data":{"currentLot":{...},"otherLots":[...]}}'
          minRows={6}
          maxRows={12}
          autosize
          value={json}
          onChange={(event) => {
            setJson(event.currentTarget.value);
            setError(null);
            setPreview(null);
          }}
          error={error}
        />
        <Button
          variant="light"
          leftSection={<IconUpload size={15} />}
          onClick={handleParse}
          disabled={!json.trim()}
        >
          解析并预览
        </Button>

        {error ? (
          <Alert icon={<IconAlertCircle size={16} />} color="red" variant="light">{error}</Alert>
        ) : null}

        {preview ? (
          <Stack gap="sm">
            <Text size="sm" fw={600}>
              识别到 {preview.lots.length} 个资源包（默认优先消耗最快过期的），汇总后将累加到账号：
            </Text>
            <Table striped highlightOnHover withTableBorder withColumnBorders className="longcat-pack-preview-table">
              <Table.Thead>
                <Table.Tr>
                  <Table.Th>资源包 ID</Table.Th>
                  <Table.Th>状态</Table.Th>
                  <Table.Th>来源</Table.Th>
                  <Table.Th>总量（Token）</Table.Th>
                  <Table.Th>已消耗</Table.Th>
                  <Table.Th>剩余</Table.Th>
                  <Table.Th>到期时间</Table.Th>
                </Table.Tr>
              </Table.Thead>
              <Table.Tbody>
                {sortLotsByPriority(preview.lots).map((lot) => (
                  <Table.Tr key={lot.lotId ?? lot.bizOrderNo}>
                    <Table.Td>{lot.lotId ?? "-"}</Table.Td>
                    <Table.Td>{lot.status === "ACTIVE" ? "生效中" : (lot.status ?? "-")}</Table.Td>
                    <Table.Td>{lot.source ?? "-"}</Table.Td>
                    <Table.Td>{formatTokenCount(lot.totalToken)}</Table.Td>
                    <Table.Td>{formatTokenCount(lot.consumedToken)}</Table.Td>
                    <Table.Td>{formatTokenCount(lot.remainingToken)}</Table.Td>
                    <Table.Td>{formatLongCatTime(lot.expireTime)}</Table.Td>
                  </Table.Tr>
                ))}
              </Table.Tbody>
            </Table>
            <Button onClick={handleImport} color="blue">
              确认导入
            </Button>
          </Stack>
        ) : null}
      </Stack>
    </Modal>
  );
}

// 抽出来的计算工具，供 AccountEditorDrawer 汇总。
export function summarizeLongCatLots(lots: LongCatLot[]): {
  total: number;
  used: number;
  remaining: number;
  expireAt: string | null;
  source: string;
} {
  // 汇总只计算 ACTIVE 状态的资源包。
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
    // 取所有包中最小的到期时间作为账号级到期时间（最早的）
    if (lot.expireTime && (!expireAt || lot.expireTime < expireAt)) {
      expireAt = lot.expireTime;
    }
  }

  return {
    total,
    used,
    remaining,
    expireAt,
    source: JSON.stringify(lots),
  };
}

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
