import { describe, expect, it } from "vitest";
import { errorMessage } from "./AppError";

describe("errorMessage", () => {
  it("reads messages from Error instances", () => {
    expect(errorMessage(new Error("网络请求失败"))).toBe("网络请求失败");
  });

  it("reads messages from plain AppError objects", () => {
    expect(errorMessage({
      code: "s3_sync_config_save_failed",
      message: "S3 Endpoint 格式无效",
      retryable: true,
    })).toBe("S3 Endpoint 格式无效");
  });

  it("does not expose object stringification to users", () => {
    expect(errorMessage({ code: "unknown" })).toBe("未知错误");
  });
});
