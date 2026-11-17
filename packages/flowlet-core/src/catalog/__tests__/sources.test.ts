// models-cn 数据源回退顺序契约测试。Owner: node-storage.
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  MODELS_CN_MIRROR_URL,
  MODELS_CN_PRIMARY_URL,
  MODELS_CN_URLS,
  modelsCnSourceCandidates,
} from "../sources.ts";

describe("models-cn 数据源候选顺序", () => {
  it("默认主站优先，GitHub Pages 作为回退", () => {
    assert.deepEqual(modelsCnSourceCandidates(), [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL]);
    assert.deepEqual(modelsCnSourceCandidates(""), [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL]);
    assert.deepEqual(modelsCnSourceCandidates("   "), [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL]);
    assert.deepEqual([...MODELS_CN_URLS], [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL]);
  });

  it("显式指定内置源时该源优先，另一个仍可回退", () => {
    assert.deepEqual(modelsCnSourceCandidates(MODELS_CN_MIRROR_URL), [MODELS_CN_MIRROR_URL, MODELS_CN_PRIMARY_URL]);
    assert.deepEqual(modelsCnSourceCandidates(MODELS_CN_PRIMARY_URL), [MODELS_CN_PRIMARY_URL, MODELS_CN_MIRROR_URL]);
    // 末尾斜杠视为同一来源
    assert.deepEqual(modelsCnSourceCandidates(`${MODELS_CN_MIRROR_URL}/`), [MODELS_CN_MIRROR_URL, MODELS_CN_PRIMARY_URL]);
  });

  it("自定义地址只请求该地址，不猜测也不回退", () => {
    assert.deepEqual(modelsCnSourceCandidates("https://catalog.example.test/api.json"), [
      "https://catalog.example.test/api.json",
    ]);
  });
});
