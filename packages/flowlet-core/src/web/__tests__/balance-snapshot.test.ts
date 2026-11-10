// save_balance_snapshot 契约测试（Node Web Host）。Owner: node-web.
//
// 回归：手动维护余额的前端 `createSnapshotDraft` 曾漏传 `raw_scraped_json`，Web Host 的
// `BALANCE_SNAPSHOT_REQUIRED` 把它当必填，导致「保存渠道账号」报
// `参数 snapshot: missing field raw_scraped_json`（前端此前还把错误对象显示成 [object Object]）。
// Rust 侧已给该字段加 serde(default)，Node 侧 required 列表同步放开。
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { JsonRow } from "../../types.ts";
import type { WebContext } from "../context.ts";
import { dispatch } from "../commands.ts";

function contextWith(saveBalanceSnapshot: (row: JsonRow) => void): WebContext {
  return { storage: { saveBalanceSnapshot } } as unknown as WebContext;
}

const BASE_SNAPSHOT = {
  id: "snapshot-123",
  account_id: "account-1",
  balance: 12.5,
  currency: "CNY",
  token_pack_total: null,
  token_pack_used: null,
  token_pack_remaining: null,
  token_pack_expire_at: null,
  token_packs: null,
  source: "manual",
  synced_at: "2026-11-10T00:00:00Z",
  remark: null,
  created_at: "2026-11-10T00:00:00Z",
  updated_at: "2026-11-10T00:00:00Z",
};

describe("save_balance_snapshot", () => {
  it("accepts a manual snapshot without raw_scraped_json (frontend draft shape)", async () => {
    const captured: JsonRow[] = [];
    const ctx = contextWith((row) => captured.push(row));
    const result = await dispatch(ctx, "save_balance_snapshot", { snapshot: { ...BASE_SNAPSHOT } });
    assert.equal(result, null);
    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.account_id, "account-1");
    assert.equal(captured[0]!.balance, 12.5);
  });

  it("still rejects a snapshot missing a genuinely required field", async () => {
    const ctx = contextWith(() => undefined);
    const { account_id: _omitted, ...withoutAccountId } = BASE_SNAPSHOT;
    await assert.rejects(
      () => dispatch(ctx, "save_balance_snapshot", { snapshot: withoutAccountId }),
      /missing field `account_id`|参数 snapshot/,
    );
  });

  it("passes raw_scraped_json through when scrape results provide it", async () => {
    const captured: JsonRow[] = [];
    const ctx = contextWith((row) => captured.push(row));
    await dispatch(ctx, "save_balance_snapshot", {
      snapshot: { ...BASE_SNAPSHOT, raw_scraped_json: '{"mode":"x"}' },
    });
    assert.equal(captured[0]!.raw_scraped_json, '{"mode":"x"}');
  });
});