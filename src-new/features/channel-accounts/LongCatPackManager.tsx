import { useState } from "react";
import { Button, Input, Modal, TextArea } from "@douyinfe/semi-ui-19";
import { IconDelete, IconPlus } from "@douyinfe/semi-icons";
import styles from "./LongCatPackManager.module.css";
import { useAppPreferences } from "../../app/preferences/AppPreferences";

export type LongCatPack = {
  lotId?: number;
  totalToken?: number;
  consumedToken?: number;
  remainingToken?: number;
  expireTime?: string;
  status?: string;
  source?: string;
  grantCategory?: string;
};

type Props = {
  initialPacks: LongCatPack[];
  onCancel: () => void;
  onSave: (packs: LongCatPack[]) => void;
};

let nextLocalId = -1;

function newLocalId() {
  nextLocalId -= 1;
  return nextLocalId;
}

export function parseLongCatPacks(text: string): LongCatPack[] {
  if (!text.trim()) throw new Error("请输入 LongCat 资源包接口返回的 JSON 数据");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("JSON 解析失败，请检查粘贴内容是否完整");
  }

  const root = parsed as Record<string, unknown> | null;
  const data = root && typeof root === "object" && root.data && typeof root.data === "object"
    ? root.data as Record<string, unknown>
    : root;
  if (!data || typeof data !== "object") throw new Error("未找到资源包数据，请确认接口响应格式正确");

  const current = data.currentLot;
  const others = Array.isArray(data.otherLots) ? data.otherLots : [];
  const packs: LongCatPack[] = [];
  if (current && typeof current === "object") packs.push(current as LongCatPack);
  for (const item of others) {
    if (!item || typeof item !== "object") continue;
    const pack = item as LongCatPack;
    if (pack.lotId == null || !packs.some((existing) => existing.lotId === pack.lotId)) packs.push(pack);
  }
  if (!packs.length) throw new Error("未找到任何资源包（currentLot 和 otherLots 均为空）");
  return packs.map((pack) => pack.lotId == null ? { ...pack, lotId: newLocalId() } : pack);
}

export function parseStoredLongCatPacks(value?: string | null): LongCatPack[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed as LongCatPack[] : [];
  } catch {
    return [];
  }
}

export function sortLongCatPacks(packs: LongCatPack[]) {
  return [...packs].sort((a, b) => {
    if (!a.expireTime && !b.expireTime) return 0;
    if (!a.expireTime) return 1;
    if (!b.expireTime) return -1;
    return a.expireTime.localeCompare(b.expireTime);
  });
}

export function mergeLongCatPacks(current: LongCatPack[], imported: LongCatPack[]) {
  const byId = new Map<number, LongCatPack>();
  for (const pack of [...current, ...imported]) {
    const lotId = pack.lotId ?? newLocalId();
    byId.set(lotId, pack.lotId == null ? { ...pack, lotId } : pack);
  }
  return sortLongCatPacks([...byId.values()]);
}

export function summarizeLongCatPacks(packs: LongCatPack[]) {
  const active = packs.filter((pack) => !pack.status || pack.status === "ACTIVE");
  const source = active.length ? active : packs;
  return source.reduce(
    (summary, pack) => ({
      total: summary.total + (pack.totalToken ?? 0),
      used: summary.used + (pack.consumedToken ?? 0),
      remaining: summary.remaining + (pack.remainingToken ?? 0),
      expireAt: pack.expireTime && (!summary.expireAt || pack.expireTime < summary.expireAt) ? pack.expireTime : summary.expireAt,
    }),
    { total: 0, used: 0, remaining: 0, expireAt: null as string | null },
  );
}

export function formatTokenCount(value: number, language: "zh-CN" | "en-US" = "zh-CN") {
  if (language === "en-US") return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(value);
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(1)}亿`;
  if (value >= 10_000) return `${(value / 10_000).toFixed(1)}万`;
  return String(value);
}

export function LongCatPackManager({ initialPacks, onCancel, onSave }: Props) {
  const { language, t } = useAppPreferences();
  const [packs, setPacks] = useState(() => sortLongCatPacks(initialPacks));
  const [json, setJson] = useState("");
  const [error, setError] = useState<string | null>(null);
  const summary = summarizeLongCatPacks(packs);

  const addPack = () => setPacks((current) => [...current, { lotId: newLocalId(), status: "ACTIVE" }]);
  const updatePack = (index: number, patch: Partial<LongCatPack>) => {
    setPacks((current) => current.map((pack, currentIndex) => currentIndex === index ? { ...pack, ...patch } : pack));
  };
  const removePack = (index: number) => setPacks((current) => current.filter((_, currentIndex) => currentIndex !== index));

  const importJson = () => {
    try {
      setPacks((current) => mergeLongCatPacks(current, parseLongCatPacks(json)));
      setJson("");
      setError(null);
    } catch (reason) {
      setError(t(reason instanceof Error ? reason.message : String(reason)));
    }
  };

  return (
    <Modal
      visible
      motion={false}
      zIndex={1200}
      width="min(940px, 96vw)"
      title={t("LongCat 资源包管理")}
      footer={(
        <div className={styles.footer}>
          <Button onClick={onCancel}>{t("取消")}</Button>
          <Button theme="solid" type="primary" onClick={() => onSave(sortLongCatPacks(packs))}>{t("保存资源包")}</Button>
        </div>
      )}
      onCancel={onCancel}
    >
      <div className={styles.body}>
        <div className={styles.importPanel}>
          <p>{t("在 LongCat 控制台获取资源包接口的响应 JSON，粘贴后可批量导入；相同资源包 ID 会自动覆盖更新。")} <code>/api/pay/quota/metering/token-packs/summary</code></p>
          <TextArea
            aria-label={language === "zh-CN" ? "LongCat 资源包 JSON" : "LongCat package JSON"}
            value={json}
            rows={3}
            placeholder={'{"code":0,"data":{"currentLot":{...},"otherLots":[...]}}'}
            onChange={(value) => { setJson(value); setError(null); }}
          />
          {error ? <div className={styles.error}>{error}</div> : null}
          <div className={styles.importActions}>
            <Button disabled={!json.trim()} onClick={importJson}>{t("导入 JSON")}</Button>
            <Button icon={<IconPlus />} theme="borderless" onClick={addPack}>{t("添加资源包")}</Button>
          </div>
        </div>

        {packs.length ? (
          <div className={styles.tableScroll}>
            <table className={styles.table}>
              <thead><tr><th>#</th><th>{t("总量")}</th><th>{t("已消耗")}</th><th>{t("剩余")}</th><th>{t("到期时间")}</th><th>{t("状态")}</th><th>{t("操作")}</th></tr></thead>
              <tbody>
                {packs.map((pack, index) => (
                  <tr key={pack.lotId ?? index}>
                    <td>{index + 1}</td>
                    <td><NumberInput label={t("资源包 {index} 总量", { index: index + 1 })} value={pack.totalToken} onChange={(value) => updatePack(index, { totalToken: value })} /></td>
                    <td><NumberInput label={t("资源包 {index} 已消耗", { index: index + 1 })} value={pack.consumedToken} onChange={(value) => updatePack(index, { consumedToken: value })} /></td>
                    <td><NumberInput label={t("资源包 {index} 剩余", { index: index + 1 })} value={pack.remainingToken} onChange={(value) => updatePack(index, { remainingToken: value })} /></td>
                    <td><Input aria-label={t("资源包 {index} 到期时间", { index: index + 1 })} type="date" value={pack.expireTime?.slice(0, 10) ?? ""} onChange={(value) => updatePack(index, { expireTime: value ? `${value}T23:59:59` : undefined })} /></td>
                    <td><Input aria-label={t("资源包 {index} 状态", { index: index + 1 })} value={pack.status ?? ""} placeholder="ACTIVE" onChange={(value) => updatePack(index, { status: value || undefined })} /></td>
                    <td><Button aria-label={t("删除资源包 {index}", { index: index + 1 })} icon={<IconDelete />} theme="borderless" type="danger" onClick={() => removePack(index)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <div className={styles.empty}>{t("暂无资源包，请导入 JSON 或手动添加。")}</div>}

        <div className={styles.summary}>
          <span>{t("共 {count} 个资源包", { count: packs.length })}</span>
          <span>{t("总量")} <strong>{formatTokenCount(summary.total, language)}</strong></span>
          <span>{t("已消耗")} <strong>{formatTokenCount(summary.used, language)}</strong></span>
          <span>{t("剩余")} <strong>{formatTokenCount(summary.remaining, language)}</strong></span>
          <span>{t("最早到期")} <strong>{summary.expireAt?.slice(0, 10) ?? "-"}</strong></span>
        </div>
      </div>
    </Modal>
  );
}

function NumberInput({ label, value, onChange }: { label: string; value?: number; onChange: (value?: number) => void }) {
  return <Input aria-label={label} type="number" min={0} value={value == null ? "" : String(value)} onChange={(next) => onChange(next === "" ? undefined : Number(next))} />;
}
