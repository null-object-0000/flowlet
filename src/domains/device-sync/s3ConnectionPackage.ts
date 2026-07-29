import type { S3SyncConfigInput } from "./types";

export const S3_CONNECTION_PACKAGE_TYPE = "flowlet.s3-connection";
export const S3_CONNECTION_PACKAGE_VERSION = 1;

export type S3ConnectionPackage = {
  type: typeof S3_CONNECTION_PACKAGE_TYPE;
  version: typeof S3_CONNECTION_PACKAGE_VERSION;
  config: Omit<S3SyncConfigInput, "secretAccessKey"> & {
    secretAccessKey: string;
  };
};

export function createS3ConnectionPackage(config: S3SyncConfigInput): S3ConnectionPackage {
  const secretAccessKey = config.secretAccessKey?.trim();
  if (!secretAccessKey) {
    throw new Error("连接包必须包含 Secret Access Key");
  }
  return {
    type: S3_CONNECTION_PACKAGE_TYPE,
    version: S3_CONNECTION_PACKAGE_VERSION,
    config: {
      endpoint: config.endpoint.trim(),
      region: config.region.trim(),
      bucket: config.bucket.trim(),
      prefix: config.prefix.trim(),
      accessKeyId: config.accessKeyId.trim(),
      secretAccessKey,
      pathStyle: config.pathStyle,
    },
  };
}

export function serializeS3ConnectionPackage(
  config: S3SyncConfigInput,
  compact = false,
): string {
  return JSON.stringify(createS3ConnectionPackage(config), null, compact ? undefined : 2);
}

export function parseS3ConnectionPackage(text: string): S3SyncConfigInput {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    throw new Error("连接文本不是有效的 JSON");
  }
  if (!isRecord(value)
    || value.type !== S3_CONNECTION_PACKAGE_TYPE
    || value.version !== S3_CONNECTION_PACKAGE_VERSION
    || !isRecord(value.config)) {
    throw new Error("不是受支持的 Flowlet S3 连接包");
  }

  const config = value.config;
  const endpoint = requiredString(config.endpoint, "Endpoint");
  const region = requiredString(config.region, "Region");
  const bucket = requiredString(config.bucket, "Bucket");
  const accessKeyId = requiredString(config.accessKeyId, "Access Key ID");
  const secretAccessKey = requiredString(config.secretAccessKey, "Secret Access Key");
  if (typeof config.pathStyle !== "boolean") {
    throw new Error("连接包中的 Path-style 配置无效");
  }

  return {
    endpoint,
    region,
    bucket,
    prefix: typeof config.prefix === "string" ? config.prefix.trim() : "",
    accessKeyId,
    secretAccessKey,
    pathStyle: config.pathStyle,
  };
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`连接包缺少 ${label}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
