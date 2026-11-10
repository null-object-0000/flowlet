// Web Host admin 鉴权。Owner: node-web.
//
// 权威实现：src-tauri/src/core/web/mod.rs `check_auth`。
// Rust 把 token 与期望值分别用固定 key `flowlet-web-admin` 做 HMAC-SHA256，
// 再用 `verify_slice`（常量时间）比较。Node 侧用同样的 HMAC + timingSafeEqual。
import { createHmac, timingSafeEqual } from "node:crypto";

const HMAC_KEY = "flowlet-web-admin";

function digest(value: string): Buffer {
  return createHmac("sha256", HMAC_KEY).update(value, "utf8").digest();
}

/**
 * 校验 `Authorization: Bearer <admin_token>`。
 *
 * 与 Rust 一致：只认 `Bearer ` 前缀；期望凭据为空时一律拒绝；比较为常量时间。
 */
export function checkAdminAuth(authorization: string | undefined, expected: string): boolean {
  if (!expected || typeof authorization !== "string") return false;
  if (!authorization.startsWith("Bearer ")) return false;
  const token = authorization.slice("Bearer ".length);
  const actual = digest(token);
  const wanted = digest(expected);
  return timingSafeEqual(actual, wanted);
}