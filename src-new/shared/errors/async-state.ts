/** Explicit UI async state discriminator. Components must render all four
 *  cases — never collapse "error" into "empty" or swallow a rejection into
 *  a default empty array. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: AppError }
  | { status: "empty" }
  | { status: "ready"; data: T };

import type { AppError } from "./AppError";

export function isLoading<T>(s: AsyncState<T>): s is { status: "loading" } {
  return s.status === "loading";
}
export function isError<T>(s: AsyncState<T>): s is { status: "error"; error: AppError } {
  return s.status === "error";
}
export function isEmpty<T>(s: AsyncState<T>): s is { status: "empty" } {
  return s.status === "empty";
}
export function isReady<T>(s: AsyncState<T>): s is { status: "ready"; data: T } {
  return s.status === "ready";
}
