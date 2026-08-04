import { describe, expect, it } from "vitest";
import { serializeS3ConnectionPackage } from "../device-sync/s3ConnectionPackage";
import type { S3SyncConfigInput } from "../device-sync/types";
import { parseSyncPackage } from "./syncPackage";
import type { DesktopAccountWorkspacePackage } from "./types";

const config: S3SyncConfigInput = {
  endpoint: "https://s3.oss-cn-shanghai.aliyuncs.com",
  region: "cn-shanghai",
  bucket: "flowlet-sync",
  prefix: "users/me",
  accessKeyId: "access-key",
  secretAccessKey: "secret-key",
  pathStyle: false,
};

const workspacePackage: DesktopAccountWorkspacePackage = {
  format: "flowlet-desktop-account-workspace",
  version: 1,
  s3: { ...config },
  accountWorkspaceKey: "d29ya3NwYWNlLWtleQ==",
};

describe("parseSyncPackage", () => {
  it("parses a plain S3 connection package", () => {
    expect(parseSyncPackage(serializeS3ConnectionPackage(config))).toEqual({
      kind: "connection",
      config,
    });
  });

  it("parses a desktop workspace package, which is a superset of the connection package", () => {
    expect(parseSyncPackage(JSON.stringify(workspacePackage, null, 2))).toEqual({
      kind: "workspace",
      package: workspacePackage,
    });
  });

  it("rejects a workspace package without the workspace key", () => {
    expect(() =>
      parseSyncPackage(JSON.stringify({ ...workspacePackage, accountWorkspaceKey: "  " })),
    ).toThrow("工作区解密密钥");
  });

  it("rejects a workspace package without the S3 secret", () => {
    expect(() =>
      parseSyncPackage(
        JSON.stringify({ ...workspacePackage, s3: { ...config, secretAccessKey: null } }),
      ),
    ).toThrow("Secret Access Key");
  });

  it("rejects unsupported workspace package versions", () => {
    expect(() => parseSyncPackage(JSON.stringify({ ...workspacePackage, version: 2 }))).toThrow(
      "版本",
    );
  });

  it("falls back to the connection package error for unknown formats", () => {
    expect(() => parseSyncPackage('{"type":"other"}')).toThrow("受支持");
  });
});
