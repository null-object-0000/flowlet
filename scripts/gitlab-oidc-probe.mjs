#!/usr/bin/env node
/**
 * Dev-only M0 probe for Flowlet admin OIDC (target: 17usoft GitLab).
 *
 * 不是产品代码，不参与 tsc/vite 构建；M0 门禁通过后可以删除。
 *
 * 用途：在创建 GitLab OAuth 应用后，用真实浏览器 + 真实凭据验证目标实例是否真的提供
 * 标准 OIDC（id_token / iss / nonce / groups / PKCE / client 认证），避免我们按标准
 * OIDC 假设实现、最后发现是定制 OAuth2。
 *
 * 零依赖，Node >= 20。用法：
 *
 *   # 1) 只读取 discovery（不需要 client 凭据）
 *   node --use-system-ca scripts/gitlab-oidc-probe.mjs --discovery
 *
 *   # 2) 凭据放在被 .gitignore 的 .env.oidc-probe（0600），不要写进命令行/仓库：
 *   #    FLOWLET_PROBE_CLIENT_ID=...
 *   #    FLOWLET_PROBE_CLIENT_SECRET=...
 *   #    FLOWLET_PROBE_GITLAB_BASE=https://git.17usoft.com
 *   set -a; . ./.env.oidc-probe; set +a
 *   node --use-system-ca scripts/gitlab-oidc-probe.mjs
 *
 *   # 3) 额外测 PKCE（默认不发送 code_challenge）：
 *   node --use-system-ca scripts/gitlab-oidc-probe.mjs --pkce
 *
 *   # 目标实例 issuer 是 http（endpoints 是 https），加 --allow-http-issuer
 *   node --use-system-ca scripts/gitlab-oidc-probe.mjs --allow-http-issuer
 *
 *   # 输出完整 sub/username/email（用于 FLOWLET_OIDC_ALLOWED_SUBS）：
 *   node --use-system-ca scripts/gitlab-oidc-probe.mjs --allow-http-issuer --show-identifiers
 *
 *   # 若准备用 GitLab 组名单而不是单用户 sub，加 --require-groups 让 groups 缺失成为失败项：
 *   node --use-system-ca scripts/gitlab-oidc-probe.mjs --allow-http-issuer --show-identifiers --require-groups
 *
 * GitLab 应用还要临时登记回调（Redirect URI 每行一个）：
 *   http://127.0.0.1:8765/callback
 *
 * 输出只打印脱敏 token（前缀 + 长度），claims 中的邮箱会打码；不会把 code/token 写入磁盘。
 */

import crypto from "node:crypto";
import http from "node:http";
import process from "node:process";

const argv = process.argv.slice(2);
const has = (name) => argv.includes(name);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};

const base = (process.env.FLOWLET_PROBE_GITLAB_BASE || "https://git.17usoft.com").replace(/\/+$/, "");
const port = Number(opt("--port", process.env.FLOWLET_PROBE_PORT || "8765"));
const redirectUri =
  process.env.FLOWLET_PROBE_REDIRECT_URI || `http://127.0.0.1:${port}/callback`;
const clientId = process.env.FLOWLET_PROBE_CLIENT_ID || "";
const clientSecret = process.env.FLOWLET_PROBE_CLIENT_SECRET || "";
const clientAuth = opt("--client-auth", "client_secret_basic");
const scope = process.env.FLOWLET_PROBE_SCOPE || "openid";
const withPkce = has("--pkce");
const discoveryOnly = has("--discovery");
const timeoutSec = Number(opt("--timeout", "180"));
const allowHttp = has("--allow-http");
const allowHttpIssuer = has("--allow-http-issuer");
const showIdentifiers = has("--show-identifiers");
const requireGroups = has("--require-groups");

const verdict = [];
const note = (ok, text) => {
  verdict.push({ ok, text });
  console.log(`${ok ? "  ✔" : "  ✖"} ${text}`);
};
const info = (text) => console.log(`  ℹ ${text}`);
const warn = (text) => console.log(`  ⚠ ${text}`);
const fail = (text) => {
  console.error(`\n✖ ${text}`);
  process.exit(1);
};
const mask = (value, keep = 6) => {
  const s = String(value ?? "");
  return s.length <= keep ? "*".repeat(s.length) : `${s.slice(0, keep)}…(${s.length})`;
};
const maskEmail = (value) => {
  const s = String(value ?? "");
  const at = s.indexOf("@");
  return at <= 0 ? mask(s) : `${s[0]}***@${s.slice(at + 1)}`;
};
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256 = (text) => crypto.createHash("sha256").update(text).digest();
const rand = (bytes = 32) => b64url(crypto.randomBytes(bytes));

async function requestJson(url, init) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* keep text */
  }
  return { res, text, json };
}

function decodeJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    return {
      header: JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8")),
      payload: JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")),
      signingInput: `${parts[0]}.${parts[1]}`,
      signature: Buffer.from(parts[2], "base64url"),
    };
  } catch {
    return null;
  }
}

async function verifyJwtSignature(decoded, jwksUri) {
  if (!decoded) return { ok: false, reason: "JWT 无法解码" };
  if (decoded.header.alg !== "RS256") {
    return { ok: false, reason: `非 RS256（alg=${decoded.header.alg}）` };
  }
  const jwks = await requestJson(jwksUri, { headers: { accept: "application/json" } });
  if (!jwks.res.ok || !jwks.json?.keys?.length) {
    return { ok: false, reason: `JWKS 拉取失败（HTTP ${jwks.res.status}）` };
  }
  const candidates = jwks.json.keys.filter(
    (key) =>
      key.kty === "RSA" &&
      (!decoded.header.kid || key.kid === decoded.header.kid) &&
      (!key.alg || key.alg === "RS256"),
  );
  for (const jwk of candidates) {
    try {
      const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
      const ok = crypto.verify(
        "RSA-SHA256",
        Buffer.from(decoded.signingInput),
        key,
        decoded.signature,
      );
      if (ok) return { ok: true, kid: jwk.kid };
    } catch {
      /* try next key */
    }
  }
  return { ok: false, reason: "没有匹配的签名密钥或验签失败" };
}

function authorizeUrl(discovery, { state, nonce, verifier }) {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  if (verifier) {
    url.searchParams.set("code_challenge", b64url(sha256(verifier)));
    url.searchParams.set("code_challenge_method", "S256");
  }
  return url.toString();
}

async function exchangeCode(discovery, code, verifier) {
  const attempts =
    clientAuth === "client_secret_post" ? ["post", "basic"] : ["basic", "post"];
  const errors = [];
  for (const method of attempts) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
    });
    const headers = {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    };
    if (method === "post") {
      body.set("client_id", clientId);
      body.set("client_secret", clientSecret);
    } else {
      headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString("base64")}`;
    }
    if (verifier) body.set("code_verifier", verifier);
    const result = await requestJson(discovery.token_endpoint, {
      method: "POST",
      headers,
      body: body.toString(),
    });
    if (result.res.ok && result.json) {
      console.log(`  token 端点认证方式：${method}`);
      return result.json;
    }
    errors.push(`${method}: HTTP ${result.res.status} ${result.text.slice(0, 160)}`);
  }
  return { __error: errors.join(" | ") };
}

async function main() {
  if (!base.startsWith("https://") && !allowHttp) {
    fail(`GitLab base 必须是 https（除非显式 --allow-http）：${base}`);
  }
  console.log(`\n== 1. Discovery ==`);
  console.log(`URL: ${base}/.well-known/openid-configuration`);
  const discoveryRes = await requestJson(`${base}/.well-known/openid-configuration`, {
    headers: { accept: "application/json" },
  });
  if (!discoveryRes.res.ok || !discoveryRes.json) {
    fail(`discovery 失败：HTTP ${discoveryRes.res.status}；返回不是 JSON。`);
  }
  const discovery = discoveryRes.json;
  const summary = {
    issuer: discovery.issuer,
    authorization_endpoint: discovery.authorization_endpoint,
    token_endpoint: discovery.token_endpoint,
    userinfo_endpoint: discovery.userinfo_endpoint,
    jwks_uri: discovery.jwks_uri,
    scopes_supported: discovery.scopes_supported,
    response_types_supported: discovery.response_types_supported,
    response_modes_supported: discovery.response_modes_supported,
    token_endpoint_auth_methods_supported: discovery.token_endpoint_auth_methods_supported,
    id_token_signing_alg_values_supported: discovery.id_token_signing_alg_values_supported,
    code_challenge_methods_supported: discovery.code_challenge_methods_supported,
    claims_supported: discovery.claims_supported,
  };
  console.log(JSON.stringify(summary, null, 2));

  const issuerOk = typeof discovery.issuer === "string" && discovery.issuer.length > 0;
  note(issuerOk, `issuer 存在：${discovery.issuer}`);
  const expectedIssuer =
    allowHttpIssuer && discovery.issuer
      ? String(discovery.issuer).replace(/^https:\/\//, "http://")
      : base;
  note(
    discovery.issuer === expectedIssuer,
    `issuer 与预期一致（期望=${expectedIssuer}，实际=${discovery.issuer}）${
      allowHttpIssuer ? "（--allow-http-issuer）" : ""
    }`,
  );
  if (
    !allowHttpIssuer &&
    discovery.issuer &&
    String(discovery.issuer).replace(/^http:\/\//, "https://") === base
  ) {
    warn("issuer 是 http 而 base 是 https；目标实例需要 --allow-http-issuer 与 ALLOW_HTTP_ISSUER=1。");
  }
  note(
    Array.isArray(discovery.id_token_signing_alg_values_supported) &&
      discovery.id_token_signing_alg_values_supported.includes("RS256"),
    "声明 RS256",
  );
  if (Array.isArray(discovery.code_challenge_methods_supported)) {
    info(`声明 PKCE：${discovery.code_challenge_methods_supported.join(", ")}`);
  } else {
    info("未声明 PKCE（code_challenge_methods_supported 缺失）；默认不发送，必要时用 --pkce 探测。");
  }
  note(Boolean(discovery.userinfo_endpoint), "声明 userinfo_endpoint");
  note(Boolean(discovery.jwks_uri), "声明 jwks_uri");
  if (discoveryOnly) {
    console.log("\n（--discovery 模式，不发起登录。）");
    return;
  }

  if (!clientId || !clientSecret) {
    fail(
      "缺少 FLOWLET_PROBE_CLIENT_ID / FLOWLET_PROBE_CLIENT_SECRET；请从 .env.oidc-probe 读取，勿写进仓库。",
    );
  }

  console.log(`\n== 2. 授权码登录 ==`);
  console.log(`redirect_uri: ${redirectUri}`);
  console.log(`scope: ${scope}`);
  console.log(`PKCE: ${withPkce ? "发送 S256（--pkce）" : "不发送（默认，兼容旧实例）"}`);
  if (withPkce && !discovery.code_challenge_methods_supported) {
    warn("discovery 未声明 PKCE；发送后 token 交换可能失败，用于探测实例是否其实支持。");
  }

  const state = rand();
  const nonce = rand();
  const verifier = rand(32); // 43 chars
  const loginUrl = authorizeUrl(discovery, { state, nonce, verifier: withPkce ? verifier : null });

  const result = await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      server.close();
      resolve(value);
    };
    const server = http.createServer(async (req, res) => {
      try {
        const requestUrl = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        if (requestUrl.pathname !== "/callback") {
          res.writeHead(404).end("not found");
          return;
        }
        const error = requestUrl.searchParams.get("error");
        if (error) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end("<h2>IdP 返回错误，请回到终端查看。</h2>");
          finish({ error, description: requestUrl.searchParams.get("error_description") });
          return;
        }
        const code = requestUrl.searchParams.get("code");
        const gotState = requestUrl.searchParams.get("state");
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<h2>Flowlet OIDC probe 已收到回调，请回到终端查看结果。</h2>");
        if (!code) return finish({ error: "missing_code" });
        if (gotState !== state) return finish({ error: "state_mismatch" });
        const token = await exchangeCode(discovery, code, withPkce ? verifier : null);
        finish({ token, nonce });
      } catch (error) {
        finish({ error: `callback failed: ${error.message}` });
      }
    });
    const timer = setTimeout(() => finish({ error: `timeout after ${timeoutSec}s` }), timeoutSec * 1000);
    server.listen(port, "127.0.0.1", () => {
      console.log("\n在浏览器打开以下 URL（需已登录目标 GitLab）：\n");
      console.log(loginUrl);
      console.log(
        `\n如果 GitLab 应用没有登记 ${redirectUri}，会先报 redirect_uri 不匹配；请在应用里临时加上这一行。\n`,
      );
    });
  });

  if (result.error) {
    console.error(`\n✖ 登录失败：${result.error}`);
    if (result.description) console.error(`  描述：${result.description}`);
    console.error("  排查：redirect_uri 是否逐字登记 / openid scope 是否勾选 / 实例是否要求 corp SSO。");
    process.exitCode = 1;
    return;
  }

  const token = result.token || {};
  console.log("\n== 3. token 端点响应（脱敏）==");
  console.log(
    JSON.stringify(
      {
        keys: Object.keys(token),
        token_type: token.token_type,
        expires_in: token.expires_in,
        scope: token.scope,
        id_token: token.id_token ? mask(token.id_token, 24) : null,
        access_token: token.access_token ? `已返回（${token.access_token.length} chars）` : null,
        refresh_token: token.refresh_token ? `已返回（${token.refresh_token.length} chars）` : null,
      },
      null,
      2,
    ),
  );
  note(Boolean(token.id_token), "token 响应包含 id_token（否则是纯 OAuth2，不是 OIDC）");
  note(Boolean(token.access_token), "token 响应包含 access_token");

  if (token.id_token) {
    console.log("\n== 4. ID token 校验（只读探测）==");
    const decoded = decodeJwt(token.id_token);
    if (!decoded) {
      note(false, "id_token 不是合法 JWT");
    } else {
      console.log("header:", JSON.stringify(decoded.header));
      console.log("payload:", JSON.stringify(decoded.payload, null, 2));
      const signature = await verifyJwtSignature(decoded, discovery.jwks_uri);
      note(signature.ok, `签名校验${signature.ok ? `通过（kid=${signature.kid}）` : `失败：${signature.reason}`}`);
      note(decoded.payload.iss === discovery.issuer, `iss 与 discovery 一致（${decoded.payload.iss}）`);
      const audOk = Array.isArray(decoded.payload.aud)
        ? decoded.payload.aud.includes(clientId)
        : decoded.payload.aud === clientId;
      note(audOk, `aud 包含 client_id`);
      note(Boolean(decoded.payload.nonce), "id_token 包含 nonce");
      note(decoded.payload.nonce === result.nonce, "nonce 与请求一致");
      note(
        Boolean(decoded.payload.sub),
        `sub 存在（${showIdentifiers ? decoded.payload.sub : mask(decoded.payload.sub)}）`,
      );
      if (showIdentifiers && decoded.payload.sub) {
        console.log(`\n  可复制到 FLOWLET_OIDC_ALLOWED_SUBS 的 sub：${decoded.payload.sub}`);
      }
    }
  }

  if (token.access_token && discovery.userinfo_endpoint) {
    console.log("\n== 5. userinfo（判权 claim）==");
    const userinfo = await requestJson(discovery.userinfo_endpoint, {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/json" },
    });
    console.log(`HTTP ${userinfo.res.status}`);
    if (userinfo.json) {
      const shown = { ...userinfo.json };
      if (!showIdentifiers) {
        for (const key of ["email", "preferred_username", "nickname"]) {
          if (shown[key]) shown[key] = maskEmail(shown[key]);
        }
        if (shown.sub) shown.sub = mask(shown.sub);
      }
      console.log(JSON.stringify(shown, null, 2));
      const groups = userinfo.json.groups;
      const groupsOk = Array.isArray(groups) && groups.length > 0;
      if (requireGroups) {
        note(groupsOk, `userinfo 返回 groups（${Array.isArray(groups) ? groups.length : 0} 个，--require-groups）`);
      } else {
        info(`userinfo groups：${groupsOk ? `${groups.length} 个（组名单可用，非 v1 单用户必需）` : "未返回（v1 单用户 sub 判权不依赖它）"}`);
      }
      if (Array.isArray(groups) && groups.length) {
        console.log("  groups（若用组名单请填完整路径）：");
        for (const group of groups.slice(0, 50)) console.log(`    - ${group}`);
      }
      info(`userinfo email：${userinfo.json.email ? "已返回（仅展示）" : "未返回（正常，v1 不依赖）"}`);
      const idTokenSub = token.id_token ? decodeJwt(token.id_token)?.payload?.sub : null;
      if (idTokenSub && userinfo.json.sub) {
        note(String(userinfo.json.sub) === String(idTokenSub), "userinfo.sub 与 id_token.sub 一致");
      } else if (!userinfo.json.sub) {
        info("userinfo 未返回 sub；单用户准入仍可用 id_token.sub。");
      }
    } else {
      note(false, `userinfo 不是 JSON：${userinfo.text.slice(0, 160)}`);
    }
  }

  console.log("\n== M0 门禁结论 ==");
  const failed = verdict.filter((item) => !item.ok);
  if (failed.length === 0) {
    console.log("✅ 全部通过，可按设计中的标准 OIDC 路径实现。");
  } else {
    console.log("❌ 存在失败项，按设计 5.7.1 的门禁决策处理（不要静默放宽校验）：");
    for (const item of failed) console.log(`   - ${item.text}`);
  }
}

main().catch((error) => {
  console.error(`\n✖ probe 失败：${error.stack || error.message}`);
  process.exitCode = 1;
});
