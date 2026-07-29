import { describe, expect, it } from "vitest";
import {
  parseS3ConnectionPackage,
  serializeS3ConnectionPackage,
} from "./s3ConnectionPackage";
import type { S3SyncConfigInput } from "./types";

const config: S3SyncConfigInput = {
  endpoint: "https://s3.oss-cn-shanghai.aliyuncs.com",
  region: "cn-shanghai",
  bucket: "flowlet-sync",
  prefix: "users/me",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  pathStyle: false,
};

describe("S3 connection package", () => {
  it("round trips a complete S3 configuration", () => {
    expect(parseS3ConnectionPackage(serializeS3ConnectionPackage(config))).toEqual(config);
  });

  it("supports compact JSON for QR codes", () => {
    const encoded = serializeS3ConnectionPackage(config, true);
    expect(encoded).not.toContain("\n");
    expect(parseS3ConnectionPackage(encoded)).toEqual(config);
  });

  it("rejects packages without a secret", () => {
    expect(() => serializeS3ConnectionPackage({ ...config, secretAccessKey: null }))
      .toThrow("Secret Access Key");
  });

  it("rejects unknown package versions", () => {
    const encoded = serializeS3ConnectionPackage(config).replace('"version": 1', '"version": 2');
    expect(() => parseS3ConnectionPackage(encoded)).toThrow("受支持");
  });
});
