import type { ChannelAccount } from "../../domains/account/types";
import { isQwenPayAsYouGoAccount } from "../../domains/channel/types";
import { formatCompactNumber, type NumberLanguage } from "../../shared/formatters/number";

/**
 * 千问 API 按量付费福利页（权益）抓取结果的解析。
 *
 * raw_scraped_json 是 Rust 侧聚合的 slot bundle：
 * - freetier_list      ListBailianFreetier（freetier 模板清单 + 安全模式）
 * - fq_instance        DescribeFqInstance 跨批合并结果（已按 Template.Code 去重裁剪，
 *                      信封仍为 { data: { Data: [...] } }）
 * - billing_amount     GetBillingAccountAvailableAmount（账户可用余额/未结清）
 * - settle_bill        ListSettleBillTotalSummary（本月结算账单，可选）
 * - cert_info          queryCurrentCertInfo（实名认证，可选）
 * - session_info       tool/user/info.json（会话信息，可选）
 */
export type QwenFreeQuotaInstance = {
  templateCode: string;
  name: string;
  status: string;
  /** InitCapacity.BaseValue：初始额度（数值口径，与 unit 同单位）。 */
  init: number | null;
  /** CurrCapacity.BaseValue：当前额度（剩余）。 */
  current: number | null;
  /** InitCapacity.ShowUnit：展示单位（千tokens / 万字 / 秒 / 张）。 */
  unit: string | null;
  /** CurrCapacity.ShowValue：展示口径数值（如 "3.000000"）。 */
  showValue: number | null;
  /** CurrCapacity.ShowUnit。 */
  showUnit: string | null;
  remainingPercent: number | null;
  cycleStartAt: string | null;
  cycleEndAt: string | null;
  endAt: string | null;
};

export type QwenFreeTierDetails = {
  balance: number | null;
  currency: string | null;
  cashBalance: number | null;
  unsettledAmount: number | null;
  billingStatus: string | null;
  settleBillCycle: string | null;
  settleBillTotal: number | null;
  certified: boolean | null;
  subjectType: string | null;
  subjectName: string | null;
  mobile: string | null;
  aliyunId: string | null;
  instances: QwenFreeQuotaInstance[];
  /** status === "valid" 且仍有剩余额度的实例（用于免费优先排序与展示）。 */
  validInstances: QwenFreeQuotaInstance[];
  expiredCount: number;
};

type JsonRecord = Record<string, unknown>;

export function parseQwenFreeTierDetails(raw?: string | null): QwenFreeTierDetails | null {
  if (!raw) return null;
  let bundle: JsonRecord;
  try {
    bundle = JSON.parse(raw) as JsonRecord;
  } catch {
    return null;
  }

  const billing = recordValue(recordValue(bundle.billing_amount)?.data);
  const instances = fqInstances(bundle.fq_instance);
  const settle = settleBill(bundle.settle_bill);
  const cert = recordValue(recordValue(bundle.cert_info)?.data);

  const validInstances = instances.filter(
    (instance) => instance.status === "valid" && (instance.current == null || instance.current > 0),
  );

  return {
    balance: numberValue(billing?.AvailableAmount),
    currency: stringValue(billing?.SettleCurrency) ?? stringValue(billing?.Currency) ?? "CNY",
    cashBalance: numberValue(billing?.CashBalanceAmount),
    unsettledAmount: numberValue(billing?.UnsettledAmount),
    billingStatus: stringValue(billing?.BillingAccountStatus),
    settleBillCycle: settle?.cycle ?? null,
    settleBillTotal: settle?.total ?? null,
    certified: booleanValue(cert?.certified),
    subjectType: stringValue(cert?.subjectType),
    subjectName: stringValue(cert?.subjectName),
    mobile: stringValue(cert?.mobile),
    aliyunId: stringValue(cert?.aliyunId),
    instances,
    validInstances,
    expiredCount: instances.length - validInstances.length,
  };
}

/** 免费额度模型名（Template.Name，即上游模型 ID）→ 额度实例，供模型勾选列表标注。 */export function qwenFreeQuotaByModel(details: QwenFreeTierDetails | null): Map<string, QwenFreeQuotaInstance> {
  const map = new Map<string, QwenFreeQuotaInstance>();
  if (!details) return map;
  for (const instance of details.validInstances) {
    const key = instance.name.trim().toLowerCase();
    if (key) map.set(key, instance);
  }
  return map;
}

/** 模型勾选列表里是否展示「免费」标：仅当前 Qwen 按量付费账号且该上游模型有有效剩余额度。 */
export function qwenFreeQuotaForAccount(
  account: Pick<ChannelAccount, "channel_id" | "resource_mode"> | undefined,
  rawScrapedJson: string | null | undefined,
  model: string,
): QwenFreeQuotaInstance | undefined {
  if (!account || !isQwenPayAsYouGoAccount(account)) return undefined;
  const details = parseQwenFreeTierDetails(rawScrapedJson);
  const map = qwenFreeQuotaByModel(details);
  return map.get(model.trim().toLowerCase());
}

/**
 * 免费额度剩余的展示文案。上游量纲是「计数单位」（千tokens / 万字），
 * 直接拼数值会很怪（1000 千tokens）；这里归一到基础单位后用紧凑格式化：
 * 千tokens → Tokens 总数（100万 / 1M），万字 → 字数（3万），秒/张等保持原值。
 */
export function formatQwenFreeQuotaValue(
  instance: QwenFreeQuotaInstance,
  language: NumberLanguage,
): string {
  const raw = instance.showValue ?? instance.current;
  if (raw == null) return "-";
  return formatQuotaAmount(raw, (instance.showUnit ?? instance.unit ?? "").trim(), language);
}

function formatQuotaAmount(value: number, unit: string, language: NumberLanguage): string {
  if (unit.includes("token")) {
    const tokens = value * countUnitScale(unit);
    return `${formatCompactNumber(Math.max(0, tokens), language)} Tokens`;
  }
  if (unit === "万字" || unit === "字") {
    const chars = value * (unit === "万字" ? 10_000 : 1);
    return `${formatCompactNumber(Math.max(0, chars), language)} 字`;
  }
  const display = value.toLocaleString(language, { maximumFractionDigits: 2 });
  return unit ? `${display} ${unit}` : display;
}

/** 「百万tokens / 万tokens / 千tokens」→ 基础 tokens 的倍率。 */
function countUnitScale(unit: string): number {
  if (unit.startsWith("百万")) return 1_000_000;
  if (unit.startsWith("亿")) return 100_000_000;
  if (unit.startsWith("万")) return 10_000;
  if (unit.startsWith("千")) return 1_000;
  return 1;
}

function fqInstances(value: unknown): QwenFreeQuotaInstance[] {
  const data = recordValue(recordValue(value)?.data)?.Data;
  if (!Array.isArray(data)) return [];
  const instances: QwenFreeQuotaInstance[] = [];
  for (const item of data) {
    const record = recordValue(item);
    if (!record) continue;
    const template = recordValue(record.Template);
    const code = stringValue(template?.Code) ?? "";
    const name = stringValue(template?.Name) ?? code;
    const init = capacity(record.InitCapacity);
    const current = capacity(record.CurrCapacity);
    const initBase = init?.base ?? null;
    const currentBase = current?.base ?? null;
    const remainingPercent =
      initBase != null && currentBase != null && initBase > 0
        ? Math.max(0, Math.min(100, (currentBase / initBase) * 100))
        : null;
    instances.push({
      templateCode: code,
      name,
      status: stringValue(record.Status) ?? "unknown",
      init: initBase,
      current: currentBase,
      unit: init?.unit ?? null,
      showValue: current?.showValue ?? null,
      showUnit: current?.showUnit ?? null,
      remainingPercent,
      cycleStartAt: cstTimestamp(record.CurrentCycleStartTime),
      cycleEndAt: cstTimestamp(record.CurrentCycleEndTime),
      endAt: cstTimestamp(record.EndTime),
    });
  }
  return instances;
}

function capacity(value: unknown): { base: number | null; unit: string | null; showValue: number | null; showUnit: string | null } | null {
  const record = recordValue(value);
  if (!record) return null;
  return {
    base: numberValue(record.BaseValue),
    unit: stringValue(record.ShowUnit) ?? stringValue(record.BaseUnit) ?? null,
    showValue: numberValue(record.ShowValue),
    showUnit: stringValue(record.ShowUnit) ?? null,
  };
}

function settleBill(value: unknown): { cycle: string | null; total: number | null } | null {
  const data = recordValue(recordValue(value)?.data)?.Data;
  if (!Array.isArray(data) || data.length === 0) return null;
  const record = recordValue(data[0]);
  if (!record) return null;
  return {
    cycle: stringValue(record.BillingCycle),
    total: numberValue(record.TotalPriceSettleFee),
  };
}

const CST_DATE_RE = /^(\w{3})\s+(\w{3})\s+(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+CST\s+(\d{4})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Tue Sep 01 00:00:00 CST 2026" → RFC3339（按 UTC+8 解析）。 */
function cstTimestamp(value: unknown): string | null {
  const raw = stringValue(value);
  if (!raw) return null;
  const match = CST_DATE_RE.exec(raw);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2]);
  if (month < 0) return null;
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const year = Number(match[7]);
  if ([day, hour, minute, second, year].some((part) => !Number.isFinite(part))) return null;
  const date = new Date(Date.UTC(year, month, day, hour - 8, minute, second));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function recordValue(value: unknown): JsonRecord | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as JsonRecord) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function booleanValue(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return null;
}