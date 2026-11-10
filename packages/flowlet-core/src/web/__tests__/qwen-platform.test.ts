// 千问平台 HTTP 通道（Node Web Host）测试。Owner: node-web.
//
// 运行：node --test packages/flowlet-core/src/web/__tests__/qwen-platform.test.ts
// 覆盖：PKCE S256（RFC 7636 向量）、device-code/token 信封解析与轮询状态映射、
// 免费额度单位归一（英文单位 → 前端可识别标签 + 基础单位数量）、cs-data 信封
// （成功/业务失败/未登录）、slot bundle 形状、凭据文件读写与 0600、本地 mock
// HTTP 上的完整登录/按量付费同步/Token Plan 同步/错误映射。
//
// 只访问 127.0.0.1 本地 mock：测试把全局 fetch 重写到 mock 服务器，生产代码里的
// 官方 URL 不变（只验证 path/query/body 与鉴权头）。
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { CommandError } from "../../types.ts";
import type { JsonRow } from "../../types.ts";
import type { WebContext } from "../context.ts";
import { dispatch } from "../commands.ts";
import {
  CS_API_QUOTA_CONFIG,
  CS_API_RESET_CARDS,
  CS_API_SUBSCRIPTION,
  CS_API_USAGE,
  LOGIN_EXPIRED_MESSAGE,
  PlatformError,
  TOKEN_PLAN_SOLO_BUY_COMMODITY,
  buildSlotBundle,
  canonicalUnit,
  classifyDeviceError,
  codeChallenge,
  credentialStorePath,
  csDataRequest,
  generateCodeVerifier,
  isCredentialsExpired,
  loadCredentialStore,
  loadCredentials,
  loadOrCreateClientId,
  logout,
  migrateLegacyCredentials,
  nowBillingCycleYyyymm,
  normalizeCapacity,
  normalizeFreeTierInstance,
  parseDeviceCodeBody,
  parseExpireTime,
  parseGatewayBody,
  parseTokenBody,
  platformAccountKind,
  platformKeyOf,
  pollLogin,
  removeCredentials,
  resolveAccountCredentials,
  saveCredentials,
  startLogin,
  status,
  syncAccount,
  unitScale,
  validateAccountId,
  validateCsDataBody,
} from "../qwen-platform.ts";

// ─── 测试夹具 ───────────────────────────────────────────────────────────────

const PAYG_ACCOUNT: JsonRow = {
  id: "acc-payg",
  channel_id: "qwen",
  resource_mode: null,
};
const TOKEN_PLAN_ACCOUNT: JsonRow = {
  id: "acc-plan",
  channel_id: "qwen",
  resource_mode: "token_plan",
};

/** 线上实测 DescribeFqInstance 返回英文单位，且带账号身份字段。 */
const FREE_TIER_INSTANCE: JsonRow = {
  InstanceName: "dashscope_sfm_1",
  Uid: 1494342465971857,
  StartTime: "Tue Nov 03 00:00:00 CST 2026",
  Status: "valid",
  Template: { Code: "sfm_tpl_1" },
  InitCapacity: {
    BaseValue: 1000000,
    ShowUnit: "Thousand Tokens",
    ShowValue: "1000.000000",
  },
  CurrCapacity: {
    BaseValue: 250000,
    ShowUnit: "Thousand Tokens",
    ShowValue: "250.000000",
  },
  CurrentCycleStartTime: "Tue Nov 03 00:00:00 CST 2026",
  CurrentCycleEndTime: "Tue Feb 02 00:00:00 CST 2027",
  EndTime: "Tue Feb 02 00:00:00 CST 2027",
};

function futureIso(offsetMs = 3_600_000): string {
  return new Date(Date.now() + offsetMs).toISOString();
}

function expiredIso(): string {
  return new Date(Date.now() - 3_600_000).toISOString();
}

function csEnvelope(business: unknown, ret = "SUCCESS::ok"): JsonRow {
  return {
    code: "200",
    successResponse: true,
    data: {
      success: true,
      DataV2: { ret: [ret], data: { data: business } },
    },
  };
}

function csBusinessErrorEnvelope(ret: string): JsonRow {
  return {
    code: "200",
    successResponse: true,
    data: { success: true, DataV2: { ret: [ret] } },
  };
}

// ─── 本地 mock HTTP 服务器 ───────────────────────────────────────────────────

interface MockRequest {
  method: string;
  pathname: string;
  search: string;
  query: URLSearchParams;
  headers: IncomingMessage["headers"];
  body: string;
}

interface MockResponse {
  status?: number;
  json?: unknown;
  text?: string;
}

type MockHandler = (request: MockRequest) => MockResponse;

class MockQwenPlatform {
  #server: Server | null = null;
  baseUrl = "";
  requests: MockRequest[] = [];
  handlers = new Map<string, MockHandler>();

  async start(): Promise<void> {
    this.#server = createHttpServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve, reject) => {
      this.#server!.once("error", reject);
      this.#server!.listen(0, "127.0.0.1", () => {
        const address = this.#server!.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;
        this.baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    const server = this.#server;
    this.#server = null;
    if (server === null) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  reset(): void {
    this.requests = [];
    this.handlers = new Map();
  }

  on(pathname: string, handler: MockHandler): void {
    this.handlers.set(pathname, handler);
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk as Buffer));
    const recorded: MockRequest = {
      method: request.method ?? "GET",
      pathname: url.pathname,
      search: url.search,
      query: url.searchParams,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    };
    this.requests.push(recorded);
    const handler = this.handlers.get(url.pathname);
    const result: MockResponse =
      handler === undefined ? { status: 404, json: { error: "not found" } } : handler(recorded);
    const payload =
      result.text !== undefined
        ? Buffer.from(result.text, "utf8")
        : Buffer.from(JSON.stringify(result.json ?? null), "utf8");
    response.writeHead(result.status ?? 200, {
      "content-type": result.text !== undefined ? "text/plain; charset=utf-8" : "application/json",
      "content-length": String(payload.length),
    });
    response.end(payload);
  }
}

const mock = new MockQwenPlatform();
const realFetch = globalThis.fetch;
const tempDirs: string[] = [];

function rewriteFetchToMock(baseUrl: string): void {
  globalThis.fetch = ((input: string | URL | { url: string }, init?: RequestInit) => {
    const raw =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(raw);
    return realFetch(`${baseUrl}${url.pathname}${url.search}`, init);
  }) as typeof globalThis.fetch;
}

before(async () => {
  await mock.start();
  rewriteFetchToMock(mock.baseUrl);
});

after(async () => {
  globalThis.fetch = realFetch;
  await mock.stop();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function installDefaultHandlers(): void {
  mock.on("/cli/device/code", () => ({
    json: {
      Success: true,
      Data: {
        Token: "device-token-1",
        VerificationUrl: "https://example.test/qwen/verify",
        ExpiresIn: 300,
        Interval: 2,
      },
    },
  }));
  mock.on("/cli/device/token", () => ({
    json: {
      Success: true,
      Data: {
        Status: "complete",
        Credentials: {
          AccessToken: "access-token-1",
          ExpireTime: "2026-11-12T05:54:20Z",
          User: { Id: 1494342465971857 },
        },
      },
    },
  }));
  mock.on("/api/account/info.json", () => ({
    json: { code: "200", data: { aliyunId: "nich*****@outlook.com" } },
  }));
  mock.on("/model-mapping", () => ({ json: { "qwen3.7-plus": "sfm_tpl_1" } }));
  mock.on("/data/v2/api.json", (request) => {
    const payload = JSON.parse(request.body) as JsonRow;
    switch (payload.action) {
      case "DescribeFqInstance":
        return { json: { code: "200", data: { Data: [FREE_TIER_INSTANCE] } } };
      case "GetBillingAccountAvailableAmount":
        return {
          json: {
            code: "200",
            data: {
              AvailableAmount: "92.65",
              SettleCurrency: "CNY",
              UnsettledAmount: 1.2,
            },
          },
        };
      case "GetFundAccountAvailableAmount":
        return { json: { code: "200", data: { AvailableAmount: "1.00", Currency: "CNY" } } };
      case "ListSettleBillTotalSummary":
        return {
          json: {
            code: "200",
            data: { Data: [{ BillingCycle: "202611", TotalPriceSettleFee: "1.00" }] },
          },
        };
      case "GenerateCLIAccessToken":
        return { json: { code: "200", data: { cliAccessToken: "cli-token-1" } } };
      default:
        return {
          status: 400,
          json: { code: "400", message: `unexpected action ${String(payload.action)}` },
        };
    }
  });
  mock.on("/cli/api.json", (request) => {
    const envelope = JSON.parse(
      new URLSearchParams(request.body).get("params") ?? "{}",
    ) as JsonRow;
    switch (String(envelope.Api ?? "")) {
      case CS_API_SUBSCRIPTION:
        return { json: csEnvelope({ specCode: "standard" }) };
      case CS_API_QUOTA_CONFIG:
        return { json: csEnvelope({ quotaConfig: true }) };
      case CS_API_USAGE:
        return { json: csEnvelope({ usage: true }) };
      case CS_API_RESET_CARDS:
        return { json: csEnvelope({ cards: [] }) };
      default:
        return { json: csEnvelope({}) };
    }
  });
}

beforeEach(() => {
  mock.reset();
  installDefaultHandlers();
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "flowlet-qwen-platform-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeStorage {
  accounts: JsonRow[];
  snapshots: JsonRow[];
  listChannelAccounts(): JsonRow[];
  saveBalanceSnapshot(snapshot: JsonRow): void;
}

function makeContext(dir: string, accounts: JsonRow[]): { ctx: WebContext; storage: FakeStorage } {
  const storage: FakeStorage = {
    accounts,
    snapshots: [],
    listChannelAccounts() {
      return this.accounts;
    },
    saveBalanceSnapshot(snapshot) {
      this.snapshots.push(snapshot);
    },
  };
  return { ctx: { catalogDir: dir, storage } as unknown as WebContext, storage };
}

function credentialStoreFile(dir: string): string {
  return credentialStorePath(dir);
}

function legacyCredentialFile(dir: string, accountId: string): string {
  return path.join(dir, "qwen-platform", `${accountId}.json`);
}

function writeCredentials(dir: string, accountId: string, expiresAt = futureIso()): void {
  saveCredentials(dir, accountId, {
    accessToken: "access-token-1",
    expiresAt,
    aliyunId: "aliyun-1",
    email: "a@b.c",
    updatedAt: new Date().toISOString(),
  });
}

function dataApiPayload(request: MockRequest): JsonRow {
  return JSON.parse(request.body) as JsonRow;
}

function gatewayRequest(action: string): MockRequest {
  const found = mock.requests.find((request) => {
    if (request.pathname !== "/data/v2/api.json") return false;
    return dataApiPayload(request).action === action;
  });
  assert.ok(found !== undefined, `缺少网关请求 ${action}`);
  return found;
}

function csDataEnvelopeOf(request: MockRequest): JsonRow {
  const encoded = new URLSearchParams(request.body).get("params");
  assert.ok(encoded !== null, "cs-data body 必须包含 params");
  return JSON.parse(encoded) as JsonRow;
}

// ─── PKCE ───────────────────────────────────────────────────────────────────

describe("PKCE S256", () => {
  it("codeChallenge 命中 RFC 7636 Appendix B 向量", () => {
    assert.equal(
      codeChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("verifier 是 43 字符 base64url 且每次不同", () => {
    const verifier = generateCodeVerifier();
    assert.equal(verifier.length, 43);
    assert.match(verifier, /^[A-Za-z0-9_-]+$/);
    assert.notEqual(verifier, generateCodeVerifier());
    assert.match(codeChallenge(verifier), /^[A-Za-z0-9_-]{43}$/);
  });
});

// ─── device flow 信封解析 ───────────────────────────────────────────────────

describe("device flow 信封", () => {
  it("解析 device-code 成功响应与默认值", () => {
    const data = parseDeviceCodeBody(
      '{"Success":true,"Data":{"Token":"tok","ExpiresIn":300,"VerificationUrl":"https://example.test/auth","Interval":2}}',
    );
    assert.deepEqual(data, {
      token: "tok",
      verificationUrl: "https://example.test/auth",
      expiresIn: 300,
      interval: 2,
    });

    const defaults = parseDeviceCodeBody(
      '{"Success":true,"Data":{"Token":"tok","VerificationUrl":"https://example.test/auth"}}',
    );
    assert.equal(defaults.expiresIn, 0);
    assert.equal(defaults.interval, 0);
  });

  it("device-code 失败响应保留上游 message", () => {
    assert.throws(
      () => parseDeviceCodeBody('{"Success":false,"Message":"bad client"}'),
      (error: unknown) =>
        error instanceof PlatformError &&
        error.kind === "message" &&
        error.message === "bad client",
    );
  });

  it("token 轮询状态映射 pending/slow_down/complete/expired/denied", () => {
    assert.deepEqual(
      parseTokenBody('{"Success":true,"Data":{"Status":"authorization_pending"}}'),
      { status: "pending" },
    );
    assert.deepEqual(parseTokenBody('{"Success":true,"Data":{"Status":"slow_down"}}'), {
      status: "slow_down",
    });
    assert.deepEqual(parseTokenBody('{"Success":true,"Data":{"Status":"expired_token"}}'), {
      status: "expired",
    });
    assert.deepEqual(parseTokenBody('{"Success":true,"Data":{"Status":"access_denied"}}'), {
      status: "denied",
    });
    assert.deepEqual(
      parseTokenBody('{"Success":true,"Data":{"Status":"complete","Credentials":{"AccessToken":"at","ExpireTime":"2026-12-01T00:00:00Z","User":{"Id":"u1","AliyunId":"aliyun-1","Email":"a@b.c"}}}}'),
      {
        status: "complete",
        accessToken: "at",
        expiresAt: "2026-12-01T00:00:00Z",
        aliyunId: "aliyun-1",
        email: "a@b.c",
      },
    );
  });

  it("数字 User.Id 与纯秒级 ExpireTime 也能解析（线上实测形态）", () => {
    assert.deepEqual(
      parseTokenBody(
        '{"Success":true,"Data":{"Status":"complete","Credentials":{"AccessToken":"at","ExpireTime":1790000000,"User":{"Id":1494342465971857}}}}',
      ),
      {
        status: "complete",
        accessToken: "at",
        expiresAt: "1790000000",
        aliyunId: "1494342465971857",
        email: null,
      },
    );
  });

  it("HTTP 400 body 分类：expired/token 过期、denied、slow_down", () => {
    assert.equal(classifyDeviceError(400, "expired_token").kind, "auth_expired");
    assert.equal(classifyDeviceError(400, "access_denied").message, "用户拒绝了千问平台授权");
    assert.match(classifyDeviceError(400, "slow_down").message, /登录轮询过快/);
    assert.match(classifyDeviceError(503, "boom").message, /HTTP 503: boom/);
  });
});

// ─── 网关 / cs-data 信封 ────────────────────────────────────────────────────

describe("网关与 cs-data 信封校验", () => {
  it("gateway 信封接受字符串/数字 200，鉴权失败映射为过期", () => {
    assert.deepEqual(parseGatewayBody('{"code":"200","data":{"Data":[]}}'), { Data: [] });
    assert.deepEqual(parseGatewayBody('{"code":200,"data":{}}'), {});
    assert.throws(
      () => parseGatewayBody('{"code":"401","message":"Unauthorized"}'),
      (error: unknown) => error instanceof PlatformError && error.kind === "auth_expired",
    );
    assert.throws(
      () => parseGatewayBody('{"code":"500","message":"boom"}'),
      (error: unknown) =>
        error instanceof PlatformError && error.kind === "message" && error.message === "boom",
    );
  });

  it("cs-data 成功信封返回完整响应（保留 DataV2 结构）", () => {
    const ok =
      '{"code":"200","successResponse":true,"data":{"success":true,"DataV2":{"ret":["SUCCESS::ok"],"data":{"data":{"specCode":"standard"}}}}}';
    const value = validateCsDataBody(ok);
    assert.equal(value.data.DataV2.data.data.specCode, "standard");
  });

  it("cs-data 业务失败按 message 抛错", () => {
    assert.throws(
      () =>
        validateCsDataBody(
          '{"code":"200","data":{"success":true,"DataV2":{"ret":["INVALID_ARGUMENT::bad request"]}}}',
        ),
      (error: unknown) =>
        error instanceof PlatformError &&
        error.kind === "message" &&
        error.message.includes("bad request") &&
        error.message.includes("INVALID_ARGUMENT"),
    );
  });

  it("cs-data 未登录映射为 AuthExpired", () => {
    assert.throws(
      () =>
        validateCsDataBody(
          '{"code":"200","data":{"success":false,"errorCode":"BailianGateway.Login.NotLogined"}}',
        ),
      (error: unknown) => error instanceof PlatformError && error.kind === "auth_expired",
    );
    assert.throws(
      () => validateCsDataBody('{"code":"401","message":"Unauthorized"}'),
      (error: unknown) => error instanceof PlatformError && error.kind === "auth_expired",
    );
  });

  it("cs-data 请求构造带 cornerstoneParam 且 body 是 form-urlencoded", () => {
    const { url, form } = csDataRequest(CS_API_SUBSCRIPTION, {
      commodityCode: TOKEN_PLAN_SOLO_BUY_COMMODITY,
    });
    assert.ok(url.startsWith("https://cs-data.qianwenai.com/cli/api.json?"));
    assert.ok(url.includes("action=BroadScopeAspnGateway"));
    assert.ok(url.includes("product=sfm_bailian"));
    assert.ok(url.includes("api=zeldaHttp.apikeyMgr."));
    assert.ok(form.startsWith("params="));
    assert.ok(form.endsWith("&region=cn-beijing"));
    const envelope = JSON.parse(
      decodeURIComponent(form.slice("params=".length).split("&region=")[0]!),
    ) as JsonRow;
    assert.equal(envelope.Api, CS_API_SUBSCRIPTION);
    assert.equal(envelope.V, "1.0");
    assert.equal(envelope.Data.commodityCode, TOKEN_PLAN_SOLO_BUY_COMMODITY);
    assert.equal(envelope.Data.cornerstoneParam.protocol, "V2");
    assert.equal(envelope.Data.cornerstoneParam.consoleSite, "QIANWENAI");
    assert.equal(envelope.Data.cornerstoneParam.productCode, "p_efm");
  });
});

// ─── 单位归一 / bundle 形状 ─────────────────────────────────────────────────

describe("免费额度单位归一", () => {
  it("千 tokens → tokens 且 ShowValue 用基础单位数量", () => {
    const capacity = normalizeCapacity({
      BaseValue: 1000000,
      ShowUnit: "Thousand Tokens",
      ShowValue: "1000.000000",
    });
    assert.equal(capacity.BaseValue, 1_000_000);
    assert.equal(capacity.ShowValue, "1000000");
    assert.equal(capacity.ShowUnit, "tokens");
    assert.equal(capacity.BaseUnit, "tokens");
  });

  it("TenThousand Word → 字、数量级 10000", () => {
    const capacity = normalizeCapacity({
      BaseValue: 1_000_000,
      ShowUnit: "TenThousand Word",
      ShowValue: "100.0",
    });
    assert.equal(capacity.BaseValue, 1_000_000);
    assert.equal(capacity.ShowValue, "1000000");
    assert.equal(capacity.ShowUnit, "字");
  });

  it("BaseValue 缺失时用 ShowValue × 数量级推导", () => {
    const capacity = normalizeCapacity({ ShowUnit: "Thousand Tokens", ShowValue: "12.5" });
    assert.equal(capacity.BaseValue, 12_500);
    assert.equal(capacity.ShowValue, "12500");
    assert.equal(capacity.ShowUnit, "tokens");
  });

  it("Second / Piece / 中文单位映射", () => {
    assert.equal(normalizeCapacity({ BaseValue: 3600, ShowUnit: "Second" }).ShowUnit, "秒");
    assert.equal(normalizeCapacity({ BaseValue: 500, ShowUnit: "Piece" }).ShowUnit, "张");
    assert.equal(normalizeCapacity({ BaseValue: 10, ShowUnit: "千tokens" }).ShowUnit, "tokens");
    assert.equal(normalizeCapacity({ BaseValue: 10, ShowUnit: "万字" }).ShowUnit, "字");
    assert.equal(canonicalUnit("Thousand Tokens"), "tokens");
    assert.equal(canonicalUnit("voice"), "次");
    assert.equal(unitScale("TenThousand Word"), 10_000);
    assert.equal(unitScale("Ten Thousand Word"), 10_000);
    assert.equal(unitScale("百万"), 1_000_000);
    assert.equal(unitScale("Million Tokens"), 1_000_000);
    assert.equal(unitScale("Seconds"), 1);
  });

  it("实例裁剪丢弃账号身份，并在 Name 缺失时用 mapping/Code 回填", () => {
    const mapping = new Map([["sfm_tpl_1", "qwen3.7-plus"]]);
    const normalized = normalizeFreeTierInstance(FREE_TIER_INSTANCE, mapping);
    assert.ok(normalized !== null);
    assert.equal(normalized.InstanceName, undefined);
    assert.equal(normalized.Uid, undefined);
    assert.equal(normalized.StartTime, undefined);
    assert.equal(normalized.Template.Code, "sfm_tpl_1");
    assert.equal(normalized.Template.Name, "qwen3.7-plus");
    assert.equal(normalized.Status, "valid");
    assert.equal(normalized.InitCapacity.ShowUnit, "tokens");
    assert.equal(normalized.InitCapacity.ShowValue, "1000000");
    assert.equal(normalized.CurrentCycleEndTime, "Tue Feb 02 00:00:00 CST 2027");

    // 已有 Name 不被 mapping 覆盖。
    const existing = normalizeFreeTierInstance(
      { Template: { Code: "sfm_tpl_1", Name: "qwen-existing" } },
      mapping,
    );
    assert.equal(existing?.Template.Name, "qwen-existing");

    // 没有 Name 也没有 mapping 时退回 Code。
    const fallback = normalizeFreeTierInstance({ Template: { Code: "sfm_unknown" } }, new Map());
    assert.equal(fallback?.Template.Name, "sfm_unknown");
    // 没有 Template 的实例被丢弃。
    assert.equal(normalizeFreeTierInstance({ Status: "valid" }, new Map()), null);
  });

  it("bundle 形状与槽位可选性", () => {
    const bundle = buildSlotBundle(
      [FREE_TIER_INSTANCE],
      new Map([["sfm_tpl_1", "qwen3.7-plus"]]),
      { AvailableAmount: "12.34", SettleCurrency: "CNY" },
      { Data: [{ BillingCycle: "202611" }] },
    );
    assert.equal(bundle.fq_instance.data.Data.length, 1);
    assert.equal(bundle.fq_instance.data.Data[0].Template.Name, "qwen3.7-plus");
    assert.equal(bundle.billing_amount.data.AvailableAmount, "12.34");
    assert.equal(bundle.settle_bill.data.Data[0].BillingCycle, "202611");

    const minimal = buildSlotBundle([], new Map(), null, null);
    assert.deepEqual(Object.keys(minimal), ["fq_instance"]);
    assert.deepEqual(minimal.fq_instance.data.Data, []);
  });

  it("账单周期按北京时间切分", () => {
    assert.equal(nowBillingCycleYyyymm(new Date("2026-11-10T00:30:00Z")), "202611");
    assert.equal(nowBillingCycleYyyymm(new Date("2026-10-31T17:00:00Z")), "202611");
  });
});

// ─── 账号模式 / 凭据文件 ────────────────────────────────────────────────────

describe("账号资源模式与凭据落盘", () => {
  it("resource_mode 映射：null/pay_as_you_go → 按量付费，token_plan → 订阅", () => {
    assert.equal(platformAccountKind({ channel_id: "qwen", resource_mode: null }), "pay_as_you_go");
    assert.equal(
      platformAccountKind({ channel_id: "qwen", resource_mode: "pay_as_you_go" }),
      "pay_as_you_go",
    );
    assert.equal(
      platformAccountKind({ channel_id: "qwen", resource_mode: "token_plan" }),
      "token_plan",
    );
    assert.equal(platformAccountKind({ channel_id: "qwen", resource_mode: "token_pack" }), null);
    assert.equal(platformAccountKind({ channel_id: "deepseek", resource_mode: null }), null);
  });

  it("凭据写入/读取/删除 roundtrip，共享存储文件权限 0600", () => {
    const dir = makeTempDir();
    const credentials = {
      accessToken: "token-1",
      expiresAt: "2026-12-01T00:00:00Z",
      aliyunId: "aliyun-1",
      email: "a@b.c",
      updatedAt: "2026-11-10T00:00:00Z",
    };
    saveCredentials(dir, "acc-1", credentials);
    const file = credentialStoreFile(dir);
    const stored = JSON.parse(readFileSync(file, "utf8")) as JsonRow;
    assert.equal(stored.version, 1);
    assert.deepEqual(stored.platforms["aliyun-1"], credentials);
    assert.deepEqual(stored.accounts, { "acc-1": "aliyun-1" });
    if (process.platform !== "win32") {
      assert.equal(statSync(file).mode & 0o777, 0o600);
    }
    assert.deepEqual(loadCredentials(dir, "acc-1"), credentials);
    assert.equal(removeCredentials(dir, "acc-1"), true);
    assert.equal(removeCredentials(dir, "acc-1"), false);
    assert.equal(loadCredentials(dir, "acc-1"), null);
    // 最后一个绑定者登出后平台令牌一并删除。
    assert.deepEqual(loadCredentialStore(dir).platforms, {});
  });

  it("损坏/缺字段的凭据按未登录处理（旧文件与共享存储都容错）", () => {
    const dir = makeTempDir();
    const platformDir = path.join(dir, "qwen-platform");
    mkdirSync(platformDir, { recursive: true });
    writeFileSync(legacyCredentialFile(dir, "acc-broken"), "{not json");
    assert.equal(loadCredentials(dir, "acc-broken"), null);
    writeFileSync(
      legacyCredentialFile(dir, "acc-legacy"),
      JSON.stringify({ accessToken: "t", expiresAt: null, aliyunId: null, email: null }),
    );
    assert.equal(loadCredentials(dir, "acc-legacy"), null);

    writeFileSync(credentialStoreFile(dir), "{not json");
    assert.deepEqual(loadCredentialStore(dir), { version: 1, platforms: {}, accounts: {} });
    assert.equal(loadCredentials(dir, "acc-broken"), null);
  });

  it("非法 accountId 拒绝落盘（防路径穿越）", () => {
    const dir = makeTempDir();
    assert.throws(
      () => validateAccountId("../etc/passwd"),
      (error: unknown) =>
        error instanceof PlatformError && error.message === "非法账号 id: ../etc/passwd",
    );
    assert.throws(
      () => saveCredentials(dir, "../etc/passwd", {
        accessToken: "t",
        expiresAt: null,
        aliyunId: null,
        email: null,
        updatedAt: "",
      }),
      /非法账号 id/,
    );
    assert.doesNotThrow(() => validateAccountId("acc-1_ok"));
  });

  it("client-id 持久化：不存在时生成 UUID，之后复用", () => {
    const dir = makeTempDir();
    const first = loadOrCreateClientId(dir);
    assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    assert.equal(loadOrCreateClientId(dir), first);
    assert.equal(readFileSync(path.join(dir, "qwen-platform", "client-id"), "utf8").trim(), first);
  });

  it("expiresAt 接受 RFC3339 / 秒 / 毫秒，解析不出按未过期", () => {
    const now = Date.now();
    assert.ok((parseExpireTime(new Date(now).toISOString()) ?? 0) > now - 5_000);
    assert.ok((parseExpireTime(String(Math.floor(now / 1000))) ?? 0) > now - 5_000);
    assert.ok((parseExpireTime(String(now + 60_000)) ?? 0) > now);
    assert.equal(parseExpireTime("not-a-date"), null);
    assert.equal(parseExpireTime(""), null);

    const base = {
      accessToken: "t",
      expiresAt: expiredIso(),
      aliyunId: null,
      email: null,
      updatedAt: "",
    };
    assert.equal(isCredentialsExpired(base), true);
    assert.equal(isCredentialsExpired({ ...base, expiresAt: futureIso() }), false);
    assert.equal(isCredentialsExpired({ ...base, expiresAt: "not-a-date" }), false);
    assert.equal(isCredentialsExpired({ ...base, expiresAt: null }), false);
  });
});

// ─── 共享平台凭据（按平台账号） ─────────────────────────────────────────────

describe("共享平台凭据（按平台账号）", () => {
  it("platformKey = aliyunId ?? email ?? default（trim）", () => {
    assert.equal(platformKeyOf("  aliyun-1  ", "a@b.c"), "aliyun-1");
    assert.equal(platformKeyOf("", " a@b.c "), "a@b.c");
    assert.equal(platformKeyOf(null, null), "default");
    assert.equal(platformKeyOf("   ", "  "), "default");
    assert.equal(platformKeyOf(undefined, undefined), "default");
  });

  it("两个账号共用一个平台令牌：第二个账号 status 直接 loggedIn 并自动绑定", () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT, TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-payg");

    const first = status(ctx, "acc-payg");
    assert.equal(first.loggedIn, true);
    assert.equal(first.aliyunId, "aliyun-1");

    // 第二个账号从未登录过：共享回退直接命中平台令牌。
    const second = status(ctx, "acc-plan");
    assert.equal(second.loggedIn, true);
    assert.equal(second.aliyunId, "aliyun-1");
    assert.equal(second.email, "a@b.c");
    assert.equal(second.expiresAt, loadCredentials(dir, "acc-payg")?.expiresAt);

    const store = loadCredentialStore(dir);
    assert.deepEqual(store.accounts, { "acc-payg": "aliyun-1", "acc-plan": "aliyun-1" });
    assert.deepEqual(Object.keys(store.platforms), ["aliyun-1"]);
  });

  it("过期绑定回退到最新有效平台令牌并重新绑定", () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT, TOKEN_PLAN_ACCOUNT]);
    saveCredentials(dir, "acc-payg", {
      accessToken: "old-token",
      expiresAt: expiredIso(),
      aliyunId: "aliyun-old",
      email: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    saveCredentials(dir, "acc-plan", {
      accessToken: "new-token",
      expiresAt: futureIso(),
      aliyunId: "aliyun-new",
      email: null,
      updatedAt: new Date().toISOString(),
    });

    const resolution = resolveAccountCredentials(dir, "acc-payg");
    assert.equal(resolution.state, "ok");
    if (resolution.state !== "ok") return;
    assert.equal(resolution.platformKey, "aliyun-new");
    assert.equal(resolution.credentials.accessToken, "new-token");
    assert.equal(resolution.rebound, true);
    assert.equal(loadCredentialStore(dir).accounts["acc-payg"], "aliyun-new");
    assert.equal(status(ctx, "acc-payg").loggedIn, true);
    assert.equal(status(ctx, "acc-payg").aliyunId, "aliyun-new");
  });

  it("status 对过期且无其它有效令牌的账号返回过期身份", () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    writeCredentials(dir, "acc-payg", expiredIso());
    const result = status(ctx, "acc-payg");
    assert.deepEqual(result, {
      accountId: "acc-payg",
      loggedIn: false,
      aliyunId: "aliyun-1",
      email: "a@b.c",
      expiresAt: loadCredentials(dir, "acc-payg")!.expiresAt,
    });
  });

  it("logout 只解绑当前账号；最后一个绑定者登出才删除平台令牌", () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT, TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-payg");
    // 第二个账号通过共享回退建立绑定。
    assert.equal(status(ctx, "acc-plan").loggedIn, true);
    const clientIdBefore = loadOrCreateClientId(dir);

    logout(ctx, "acc-payg");
    let store = loadCredentialStore(dir);
    assert.deepEqual(store.accounts, { "acc-plan": "aliyun-1" });
    assert.ok(store.platforms["aliyun-1"] !== undefined);
    assert.equal(loadCredentials(dir, "acc-payg"), null);
    // 仍被 acc-plan 引用，平台令牌不能删。
    assert.equal(status(ctx, "acc-plan").loggedIn, true);

    logout(ctx, "acc-plan");
    store = loadCredentialStore(dir);
    assert.deepEqual(store.accounts, {});
    assert.deepEqual(store.platforms, {});
    assert.equal(status(ctx, "acc-plan").loggedIn, false);
    // client-id 不随登出变化。
    assert.equal(loadOrCreateClientId(dir), clientIdBefore);
  });

  it("旧 <accountId>.json 惰性迁移：导入共享存储、绑定账号并删除旧文件", () => {
    const dir = makeTempDir();
    const platformDir = path.join(dir, "qwen-platform");
    mkdirSync(platformDir, { recursive: true });
    const legacy = {
      accessToken: "legacy-token",
      expiresAt: futureIso(),
      aliyunId: "aliyun-legacy",
      email: "legacy@example.test",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    writeFileSync(legacyCredentialFile(dir, "acc-payg"), JSON.stringify(legacy));

    const { ctx } = makeContext(dir, [PAYG_ACCOUNT, TOKEN_PLAN_ACCOUNT]);
    const migrated = status(ctx, "acc-payg");
    assert.equal(migrated.loggedIn, true);
    assert.equal(migrated.aliyunId, "aliyun-legacy");
    assert.equal(migrated.email, "legacy@example.test");
    assert.equal(existsSync(legacyCredentialFile(dir, "acc-payg")), false);
    assert.equal(existsSync(credentialStoreFile(dir)), true);

    // 另一个账号直接共享迁移后的平台令牌。
    assert.equal(status(ctx, "acc-plan").loggedIn, true);
    const store = loadCredentialStore(dir);
    assert.deepEqual(store.platforms["aliyun-legacy"], legacy);
    assert.deepEqual(store.accounts, {
      "acc-payg": "aliyun-legacy",
      "acc-plan": "aliyun-legacy",
    });
  });

  it("迁移幂等：同一平台账号多份旧文件取 updatedAt 最新的一份", () => {
    const dir = makeTempDir();
    const platformDir = path.join(dir, "qwen-platform");
    mkdirSync(platformDir, { recursive: true });
    const older = {
      accessToken: "older",
      expiresAt: futureIso(),
      aliyunId: "aliyun-1",
      email: null,
      updatedAt: "2026-10-01T00:00:00.000Z",
    };
    const newer = {
      accessToken: "newer",
      expiresAt: futureIso(),
      aliyunId: "aliyun-1",
      email: null,
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    writeFileSync(legacyCredentialFile(dir, "acc-a"), JSON.stringify(older));
    writeFileSync(legacyCredentialFile(dir, "acc-b"), JSON.stringify(newer));

    migrateLegacyCredentials(dir);
    assert.equal(loadCredentialStore(dir).platforms["aliyun-1"].accessToken, "newer");
    assert.equal(existsSync(legacyCredentialFile(dir, "acc-a")), false);
    assert.equal(existsSync(legacyCredentialFile(dir, "acc-b")), false);
    // 幂等：再跑一次不会破坏已有绑定。
    assert.deepEqual(loadCredentialStore(dir).accounts, {
      "acc-a": "aliyun-1",
      "acc-b": "aliyun-1",
    });
  });
});

// ─── device flow 集成（本地 mock） ─────────────────────────────────────────

describe("device-flow 登录（本地 mock）", () => {
  it("login_start 走 PKCE 并返回授权信息", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    const challenge = await startLogin(ctx, "acc-payg");
    assert.deepEqual(challenge, {
      verificationUrl: "https://example.test/qwen/verify",
      expiresInSeconds: 300,
      intervalSeconds: 2,
    });

    const request = mock.requests.find((item) => item.pathname === "/cli/device/code");
    assert.ok(request !== undefined);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.accept, "application/json");
    assert.ok((request.query.get("client_id") ?? "").length > 0);
    assert.equal(request.query.get("code_challenge_method"), "S256");
    assert.match(request.query.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
  });

  it("login_poll complete：保存凭据（含 identity）并可 status 查询", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    await startLogin(ctx, "acc-payg");
    const poll = await pollLogin(ctx, "acc-payg");
    // 上游只返回数字 User.Id：轮询结果保留它，展示邮箱由 identity 端点补齐。
    assert.deepEqual(poll, {
      status: "complete",
      aliyunId: "1494342465971857",
      email: "nich*****@outlook.com",
    });

    const tokenRequest = mock.requests.find((item) => item.pathname === "/cli/device/token");
    assert.ok(tokenRequest !== undefined);
    assert.equal(tokenRequest.query.get("token"), "device-token-1");
    assert.ok((tokenRequest.query.get("code_verifier") ?? "").length >= 43);
    assert.equal(tokenRequest.query.get("client_id"), mock.requests[0]!.query.get("client_id"));

    const store = loadCredentialStore(dir);
    const platformKey = "1494342465971857"; // device flow 的 User.Id → aliyunId
    assert.deepEqual(store.accounts, { "acc-payg": platformKey });
    const credentials = store.platforms[platformKey];
    assert.ok(credentials !== undefined);
    assert.equal(credentials.accessToken, "access-token-1");
    assert.equal(credentials.expiresAt, "2026-11-12T05:54:20Z");
    assert.equal(credentials.aliyunId, "1494342465971857");
    assert.equal(credentials.email, "nich*****@outlook.com");
    if (process.platform !== "win32") {
      assert.equal(statSync(credentialStoreFile(dir)).mode & 0o777, 0o600);
    }
    assert.deepEqual(loadCredentials(dir, "acc-payg"), credentials);

    const platformStatus = status(ctx, "acc-payg");
    assert.equal(platformStatus.loggedIn, true);
    assert.equal(platformStatus.aliyunId, "1494342465971857");
    assert.equal(platformStatus.email, "nich*****@outlook.com");
    assert.equal(platformStatus.expiresAt, "2026-11-12T05:54:20Z");

    logout(ctx, "acc-payg");
    assert.equal(status(ctx, "acc-payg").loggedIn, false);
    assert.equal(loadCredentials(dir, "acc-payg"), null);
  });

  it("登录一次后同平台账号共享令牌（device flow 只跑一次）", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT, TOKEN_PLAN_ACCOUNT]);
    await startLogin(ctx, "acc-payg");
    await pollLogin(ctx, "acc-payg");
    const tokenRequests = mock.requests.filter((item) => item.pathname === "/cli/device/token");
    assert.equal(tokenRequests.length, 1);

    // 第二个 Qwen 账号不需要再登录。
    const shared = status(ctx, "acc-plan");
    assert.equal(shared.loggedIn, true);
    assert.equal(shared.aliyunId, "1494342465971857");
    assert.equal(shared.email, "nich*****@outlook.com");

    const platformKey = "1494342465971857";
    assert.deepEqual(loadCredentialStore(dir).accounts, {
      "acc-payg": platformKey,
      "acc-plan": platformKey,
    });
  });

  it("没有 pending 时轮询报「请先发起」", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [{ id: "acc-empty", channel_id: "qwen", resource_mode: null }]);
    await assert.rejects(() => pollLogin(ctx, "acc-empty"), /请先发起千问平台登录/);
  });

  it("上游 400 expired 映射为 expired 并丢弃 pending", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    await startLogin(ctx, "acc-payg");
    mock.on("/cli/device/token", () => ({ status: 400, text: "expired_token" }));
    assert.equal((await pollLogin(ctx, "acc-payg")).status, "expired");
    await assert.rejects(() => pollLogin(ctx, "acc-payg"), /请先发起千问平台登录/);
  });

  it("上游 400 slow_down / access_denied 映射为轮询状态", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    await startLogin(ctx, "acc-payg");
    mock.on("/cli/device/token", () => ({ status: 400, text: "slow_down" }));
    assert.equal((await pollLogin(ctx, "acc-payg")).status, "slow_down");
    // slow_down 不终止登录：pending 仍在，可继续轮询。
    mock.on("/cli/device/token", () => ({
      json: { Success: true, Data: { Status: "authorization_pending" } },
    }));
    assert.equal((await pollLogin(ctx, "acc-payg")).status, "pending");
    mock.on("/cli/device/token", () => ({ status: 400, text: "access_denied" }));
    assert.equal((await pollLogin(ctx, "acc-payg")).status, "denied");
    await assert.rejects(() => pollLogin(ctx, "acc-payg"), /请先发起千问平台登录/);
  });

  it("其它 HTTP 400 文本抛可读错误", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    await startLogin(ctx, "acc-payg");
    mock.on("/cli/device/token", () => ({ status: 400, text: "invalid_grant" }));
    await assert.rejects(() => pollLogin(ctx, "acc-payg"), /千问登录服务返回 HTTP 400: invalid_grant/);
  });
});

// ─── 按量付费同步 ──────────────────────────────────────────────────────────

describe("qwen_platform_sync（按量付费）", () => {
  it("返回余额/币种并落库同构 bundle", async () => {
    const dir = makeTempDir();
    const { ctx, storage } = makeContext(dir, [PAYG_ACCOUNT]);
    writeCredentials(dir, "acc-payg");

    const result = await syncAccount(ctx, "acc-payg");
    assert.equal(result.accountId, "acc-payg");
    assert.equal(result.balance, 92.65);
    assert.equal(result.currency, "CNY");
    assert.equal(typeof result.syncedAt, "string");
    assert.ok(Number.isFinite(Date.parse(result.syncedAt)));

    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.equal(bundle.billing_amount.data.AvailableAmount, "92.65");
    assert.equal(bundle.billing_amount.data.SettleCurrency, "CNY");
    assert.equal(bundle.billing_amount.data.UnsettledAmount, 1.2);
    assert.equal(bundle.fq_instance.data.Data.length, 1);
    const instance = bundle.fq_instance.data.Data[0] as JsonRow;
    assert.deepEqual(instance.Template, { Code: "sfm_tpl_1", Name: "qwen3.7-plus" });
    assert.equal(instance.InstanceName, undefined);
    assert.equal(instance.Uid, undefined);
    assert.equal(instance.InitCapacity.BaseValue, 1_000_000);
    assert.equal(instance.InitCapacity.ShowValue, "1000000");
    assert.equal(instance.InitCapacity.ShowUnit, "tokens");
    assert.equal(instance.CurrCapacity.ShowUnit, "tokens");
    assert.equal(bundle.settle_bill.data.Data[0].BillingCycle, "202611");

    // 网关请求：product/region/params 全部字符串化，Bearer 访问令牌。
    const fqRequest = gatewayRequest("DescribeFqInstance");
    assert.equal(fqRequest.headers.authorization, "Bearer access-token-1");
    const fqPayload = dataApiPayload(fqRequest);
    assert.equal(fqPayload.product, "BssOpenAPI-V3");
    assert.equal(fqPayload.region, "cn-beijing");
    assert.equal(fqPayload.params.PageSize, "500");
    assert.equal(fqPayload.params.PageNumber, "1");
    assert.equal(fqPayload.params.templateCodes, '["sfm_tpl_1"]');

    const settlePayload = dataApiPayload(gatewayRequest("ListSettleBillTotalSummary"));
    const month = nowBillingCycleYyyymm(new Date());
    assert.equal(settlePayload.params.StartBillingCycle, month);
    assert.equal(settlePayload.params.EndBillingCycle, month);

    // 余额快照行形状。
    assert.equal(storage.snapshots.length, 1);
    const snapshot = storage.snapshots[0]!;
    assert.match(String(snapshot.id), /^balance-acc-payg-[0-9a-f-]{36}$/);
    assert.equal(snapshot.account_id, "acc-payg");
    assert.equal(snapshot.balance, 92.65);
    assert.equal(snapshot.currency, "CNY");
    assert.equal(snapshot.token_pack_total, null);
    assert.equal(snapshot.token_pack_used, null);
    assert.equal(snapshot.token_pack_remaining, null);
    assert.equal(snapshot.token_pack_expire_at, null);
    assert.equal(snapshot.token_packs, null);
    assert.equal(snapshot.raw_scraped_json, result.rawScrapedJson);
    assert.equal(snapshot.source, "qwen_platform");
    assert.equal(snapshot.remark, "千问平台 API");
    assert.equal(snapshot.synced_at, result.syncedAt);
    assert.equal(snapshot.created_at, result.syncedAt);
    assert.equal(snapshot.updated_at, result.syncedAt);
  });

  it("模型映射不可用时不阻断同步，Name 回填 Code", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    writeCredentials(dir, "acc-payg");
    mock.on("/model-mapping", () => ({ status: 500, text: "cdn down" }));

    const result = await syncAccount(ctx, "acc-payg");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.equal(bundle.fq_instance.data.Data[0].Template.Name, "sfm_tpl_1");
  });

  it("GetBillingAccountAvailableAmount 失败时回退 GetFundAccountAvailableAmount", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    writeCredentials(dir, "acc-payg");
    mock.on("/data/v2/api.json", (request) => {
      const payload = dataApiPayload(request);
      switch (payload.action) {
        case "DescribeFqInstance":
          return { json: { code: "200", data: { Data: [] } } };
        case "GetBillingAccountAvailableAmount":
          return { json: { code: "500", message: "not supported" } };
        case "GetFundAccountAvailableAmount":
          return {
            json: { code: "200", data: { AvailableAmount: 5, Currency: "USD" } },
          };
        case "ListSettleBillTotalSummary":
          return { json: { code: "200", data: {} } };
        default:
          return { json: { code: "200", data: {} } };
      }
    });

    const result = await syncAccount(ctx, "acc-payg");
    assert.equal(result.balance, 5);
    assert.equal(result.currency, "USD");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.equal(bundle.billing_amount.data.Currency, "USD");
  });
});

// ─── Token Plan 同步 ────────────────────────────────────────────────────────

describe("qwen_platform_sync（Token Plan）", () => {
  it("派生 CLI 令牌并经 cs-data 同步订阅/额度/用量/重置券", async () => {
    const dir = makeTempDir();
    const { ctx, storage } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");

    const result = await syncAccount(ctx, "acc-plan");
    // 合并同步：balance/currency 取按量付费结果（不再按 resource_mode 二选一）。
    assert.equal(result.balance, 92.65);
    assert.equal(result.currency, "CNY");

    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.deepEqual(Object.keys(bundle).sort(), [
      "billing_amount",
      "fq_instance",
      "quota_config",
      "reset_card_list",
      "settle_bill",
      "subscription",
      "usage",
    ]);
    // 槽位必须是完整响应，前端沿 data.DataV2.data.data 解析。
    assert.equal(bundle.subscription.data.DataV2.data.data.specCode, "standard");
    assert.equal(bundle.quota_config.data.DataV2.data.data.quotaConfig, true);
    assert.equal(bundle.usage.data.DataV2.data.data.usage, true);

    const deriveRequest = gatewayRequest("GenerateCLIAccessToken");
    const derivePayload = dataApiPayload(deriveRequest);
    assert.equal(derivePayload.product, "ModelStudioRegional");
    assert.equal(derivePayload.version, "2026-02-10");
    assert.deepEqual(derivePayload.params, {});

    const subscriptionRequest = mock.requests.find(
      (request) =>
        request.pathname === "/cli/api.json" &&
        csDataEnvelopeOf(request).Api === CS_API_SUBSCRIPTION,
    );
    assert.ok(subscriptionRequest !== undefined);
    assert.equal(subscriptionRequest.headers.authorization, "Bearer cli-token-1");
    assert.match(String(subscriptionRequest.headers["content-type"]), /x-www-form-urlencoded/);
    const envelope = csDataEnvelopeOf(subscriptionRequest);
    assert.equal(envelope.V, "1.0");
    assert.equal(envelope.Data.commodityCode, TOKEN_PLAN_SOLO_BUY_COMMODITY);
    assert.equal(envelope.Data.cornerstoneParam.protocol, "V2");
    assert.equal(envelope.Data.cornerstoneParam.consoleSite, "QIANWENAI");

    assert.equal(storage.snapshots.length, 1);
    assert.equal(storage.snapshots[0]!.raw_scraped_json, result.rawScrapedJson);
    assert.equal(storage.snapshots[0]!.balance, 92.65);
  });

  it("订阅业务错误去掉 commodityCode 重试一次", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      const data = (envelope.Data ?? {}) as JsonRow;
      if (envelope.Api === CS_API_SUBSCRIPTION) {
        if (typeof data.commodityCode === "string") {
          return { json: csBusinessErrorEnvelope("INVALID_ARGUMENT::unsupported commodity") };
        }
        return { json: csEnvelope({ specCode: "team" }) };
      }
      return { json: csEnvelope({}) };
    });

    const result = await syncAccount(ctx, "acc-plan");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.equal(bundle.subscription.data.DataV2.data.data.specCode, "team");

    const subscriptionRequests = mock.requests.filter(
      (request) =>
        request.pathname === "/cli/api.json" &&
        csDataEnvelopeOf(request).Api === CS_API_SUBSCRIPTION,
    );
    assert.equal(subscriptionRequests.length, 2);
    const secondData = (csDataEnvelopeOf(subscriptionRequests[1]!).Data ?? {}) as JsonRow;
    assert.equal(secondData.commodityCode, undefined);
  });

  it("重置券接口业务失败只跳过该槽位", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      if (envelope.Api === CS_API_RESET_CARDS) {
        return { json: csBusinessErrorEnvelope("SERVICE_UNAVAILABLE::try later") };
      }
      return { json: csEnvelope({ ok: true }) };
    });

    const result = await syncAccount(ctx, "acc-plan");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.equal(bundle.reset_card_list, undefined);
    assert.ok("subscription" in bundle);
    assert.ok("quota_config" in bundle);
    assert.ok("usage" in bundle);
  });

  it("重置券鉴权失败仍然抛出登录过期", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      if (envelope.Api === CS_API_RESET_CARDS) {
        return { status: 401, text: "Unauthorized" };
      }
      return { json: csEnvelope({}) };
    });
    await assert.rejects(() => syncAccount(ctx, "acc-plan"), new RegExp(LOGIN_EXPIRED_MESSAGE));
  });
});

// ─── 合并同步（同一个 rawScrapedJson） ─────────────────────────────────────

describe("qwen_platform_sync（合并 bundle）", () => {
  function installTokenPlanDataHandlers(): void {
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      switch (String(envelope.Api ?? "")) {
        case CS_API_SUBSCRIPTION:
          return {
            json: csEnvelope({ specCode: "standard", status: "VALID", remainingDays: 21 }),
          };
        case CS_API_QUOTA_CONFIG:
          return { json: csEnvelope({ standard: { monthly: 80000, five_hour: 2000 } }) };
        case CS_API_USAGE:
          return { json: csEnvelope({ per1MonthPercentage: 0.25, per5HourPercentage: 10 }) };
        case CS_API_RESET_CARDS:
          return { json: csEnvelope({ list: [] }) };
        default:
          return { json: csEnvelope({}) };
      }
    });
  }

  it("同一个 bundle 同时带按量付费与 Token Plan 槽位（两个解析器的必需 key 都在）", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    installTokenPlanDataHandlers();

    const result = await syncAccount(ctx, "acc-plan");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;

    // parseQwenFreeTierDetails：billing_amount / fq_instance / settle_bill。
    assert.equal(bundle.billing_amount.data.AvailableAmount, "92.65");
    assert.equal(bundle.billing_amount.data.SettleCurrency, "CNY");
    assert.equal(typeof bundle.billing_amount.data.UnsettledAmount, "number");
    assert.ok(Array.isArray(bundle.fq_instance.data.Data));
    const instance = bundle.fq_instance.data.Data[0] as JsonRow;
    assert.deepEqual(instance.Template, { Code: "sfm_tpl_1", Name: "qwen3.7-plus" });
    assert.equal(instance.InitCapacity.BaseValue, 1_000_000);
    assert.equal(instance.InitCapacity.ShowUnit, "tokens");
    assert.equal(bundle.settle_bill.data.Data[0].BillingCycle, "202611");

    // parseQwenTokenPlanDetails：subscription / quota_config / usage 的 data.DataV2.data.data。
    const subscription = bundle.subscription.data.DataV2.data.data as JsonRow;
    assert.equal(subscription.specCode, "standard");
    assert.equal(subscription.status, "VALID");
    const quotaConfig = bundle.quota_config.data.DataV2.data.data as JsonRow;
    assert.equal((quotaConfig.standard as JsonRow).monthly, 80_000);
    const usage = bundle.usage.data.DataV2.data.data as JsonRow;
    assert.equal(usage.per1MonthPercentage, 0.25);
    assert.ok(bundle.reset_card_list !== undefined, "重置券可选槽位存在");

    // 仍然只写一条余额快照，balance/currency 取按量付费结果。
    assert.equal(result.balance, 92.65);
    assert.equal(result.currency, "CNY");
  });

  it("没有 Token Plan 订阅（subscription 业务错误）时同步仍成功，只含按量付费槽位", async () => {
    const dir = makeTempDir();
    const { ctx, storage } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      if (envelope.Api === CS_API_SUBSCRIPTION) {
        return { json: csBusinessErrorEnvelope("INVALID_ARGUMENT::no token plan subscription") };
      }
      return { json: csEnvelope({}) };
    });

    const result = await syncAccount(ctx, "acc-plan");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.deepEqual(Object.keys(bundle).sort(), [
      "billing_amount",
      "fq_instance",
      "settle_bill",
    ]);
    assert.equal(result.balance, 92.65);
    assert.equal(storage.snapshots.length, 1);
  });

  it("quota_config 业务错误同样按无订阅跳过全部 Token Plan 槽位", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      if (envelope.Api === CS_API_QUOTA_CONFIG) {
        return { json: csBusinessErrorEnvelope("SERVICE_UNAVAILABLE::quota down") };
      }
      return { json: csEnvelope({ specCode: "standard" }) };
    });

    const result = await syncAccount(ctx, "acc-plan");
    const bundle = JSON.parse(result.rawScrapedJson) as JsonRow;
    assert.equal(bundle.subscription, undefined);
    assert.equal(bundle.quota_config, undefined);
    assert.equal(bundle.usage, undefined);
    assert.ok(bundle.billing_amount !== undefined);
  });

  it("Token Plan 鉴权失效仍整体报登录过期（不落余额快照）", async () => {
    const dir = makeTempDir();
    const { ctx, storage } = makeContext(dir, [TOKEN_PLAN_ACCOUNT]);
    writeCredentials(dir, "acc-plan");
    mock.on("/cli/api.json", (request) => {
      const envelope = csDataEnvelopeOf(request);
      if (envelope.Api === CS_API_SUBSCRIPTION) {
        return { status: 401, text: "Unauthorized" };
      }
      return { json: csEnvelope({}) };
    });

    await assert.rejects(() => syncAccount(ctx, "acc-plan"), new RegExp(LOGIN_EXPIRED_MESSAGE));
    assert.equal(storage.snapshots.length, 0);
  });
});

// ─── 错误映射 / dispatch 接线 ──────────────────────────────────────────────

describe("错误映射与 dispatch 接线", () => {
  it("未登录 / 登录过期 / 不支持资源模式 / 账号不存在", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [
      PAYG_ACCOUNT,
      { id: "acc-unsupported", channel_id: "qwen", resource_mode: "token_pack" },
      { id: "acc-other", channel_id: "deepseek", resource_mode: null },
    ]);

    await assert.rejects(() => syncAccount(ctx, "acc-payg"), /尚未登录千问平台/);
    await assert.rejects(
      () => syncAccount(ctx, "acc-unsupported"),
      /该账号的资源模式不支持千问平台同步/,
    );
    await assert.rejects(() => syncAccount(ctx, "acc-other"), /该账号不属于千问渠道/);
    await assert.rejects(() => syncAccount(ctx, "acc-missing"), /账号不存在/);
    assert.throws(
      () => status(ctx, "../etc/passwd"),
      (error: unknown) => error instanceof CommandError && error.status === 400,
    );

    writeCredentials(dir, "acc-payg", expiredIso());
    await assert.rejects(() => syncAccount(ctx, "acc-payg"), new RegExp(LOGIN_EXPIRED_MESSAGE));
  });

  it("网关 401 映射为登录过期固定文案", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);
    writeCredentials(dir, "acc-payg");
    mock.on("/data/v2/api.json", () => ({ status: 401, text: "Unauthorized" }));
    await assert.rejects(() => syncAccount(ctx, "acc-payg"), new RegExp(LOGIN_EXPIRED_MESSAGE));
  });

  it("dispatch 暴露全套命令且错误形状是 (400, command_failed)", async () => {
    const dir = makeTempDir();
    const { ctx } = makeContext(dir, [PAYG_ACCOUNT]);

    const statusResult = (await dispatch(ctx, "qwen_platform_status", {
      accountId: "acc-payg",
    })) as JsonRow;
    assert.deepEqual(statusResult, {
      accountId: "acc-payg",
      loggedIn: false,
      aliyunId: null,
      email: null,
      expiresAt: null,
    });

    const challenge = (await dispatch(ctx, "qwen_platform_login_start", {
      accountId: "acc-payg",
    })) as JsonRow;
    assert.equal(challenge.expiresInSeconds, 300);

    const poll = (await dispatch(ctx, "qwen_platform_login_poll", {
      accountId: "acc-payg",
    })) as JsonRow;
    assert.equal(poll.status, "complete");

    assert.equal(await dispatch(ctx, "qwen_platform_logout", { accountId: "acc-payg" }), null);

    await assert.rejects(
      () => dispatch(ctx, "qwen_platform_sync", { accountId: "acc-payg" }),
      (error: unknown) => {
        assert.ok(error instanceof CommandError);
        assert.equal(error.status, 400);
        assert.equal(error.code, "command_failed");
        assert.match(error.message, /尚未登录千问平台/);
        return true;
      },
    );

    await assert.rejects(
      () => dispatch(ctx, "qwen_platform_status", {}),
      /参数 accountId: invalid type: null, expected a string/,
    );
  });
});