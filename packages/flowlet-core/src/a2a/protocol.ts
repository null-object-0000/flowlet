/** A2A 1.0 JSON-RPC binding. Business/task execution stays in the upstream Agent. */
export type JsonObject = Record<string, unknown>;
export const asObject = (value: unknown): JsonObject =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};

export const PUSH_METHODS = new Set([
  "CreateTaskPushNotificationConfig",
  "GetTaskPushNotificationConfig",
  "ListTaskPushNotificationConfigs",
  "DeleteTaskPushNotificationConfig",
]);
export const METHODS = new Set([
  "SendMessage",
  "SendStreamingMessage",
  "GetTask",
  "ListTasks",
  "CancelTask",
  "SubscribeToTask",
  "GetExtendedAgentCard",
  ...PUSH_METHODS,
]);

export class RpcError extends Error {
  code: number;
  id: unknown;
  constructor(code: number, message: string, id: unknown = null) {
    super(message);
    this.code = code;
    this.id = id;
  }
}

export interface ServiceParameters {
  version: string;
  extensions?: string;
}

export function validateCapabilities(
  card: JsonObject,
  rpc: JsonObject,
  service: ServiceParameters,
): void {
  const fail = (code: number, message: string): never => {
    throw new RpcError(code, message, rpc.id);
  };
  // The empty version means 0.3, which this interface does not implement.
  if (!/^1\.0(?:\.\d+)?$/.test(service.version.trim()))
    fail(
      -32009,
      "VersionNotSupportedError: this interface supports A2A 1.0; send A2A-Version: 1.0",
    );
  const iface = (
    Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []
  )
    .map(asObject)
    .find(
      (i) => i.protocolBinding === "JSONRPC" && i.protocolVersion === "1.0",
    );
  if (iface?.tenant && asObject(rpc.params).tenant !== iface.tenant)
    fail(-32602, "A2A tenant must match the selected Agent interface");
  const caps = asObject(card.capabilities);
  const configuration = asObject(asObject(rpc.params).configuration);
  if (
    (PUSH_METHODS.has(String(rpc.method)) ||
      configuration.taskPushNotificationConfig !== undefined) &&
    caps.pushNotifications !== true
  )
    fail(-32003, "PushNotificationNotSupportedError");
  if (
    ["SendStreamingMessage", "SubscribeToTask"].includes(String(rpc.method)) &&
    caps.streaming !== true
  )
    fail(-32004, "UnsupportedOperationError: streaming is not supported");
  if (rpc.method === "GetExtendedAgentCard" && caps.extendedAgentCard !== true)
    fail(
      -32004,
      "UnsupportedOperationError: extended Agent Card is not supported",
    );
  const accepted = new Set(
    (service.extensions ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const extension of Array.isArray(caps.extensions)
    ? caps.extensions
    : []) {
    const ext = asObject(extension);
    if (
      ext.required === true &&
      typeof ext.uri === "string" &&
      !accepted.has(ext.uri)
    )
      fail(-32008, `ExtensionSupportRequiredError: ${ext.uri}`);
  }
}

/** Discovery must describe the gateway interface and authentication, never stale signatures. */
export function gatewayCard(
  source: JsonObject,
  gatewayUrl: string,
  selectedInterface: JsonObject,
): JsonObject {
  const {
    signatures: _sig,
    securitySchemes: _schemes,
    security: _security,
    securityRequirements: _requirements,
    supportedInterfaces: _interfaces,
    url: _url,
    ...card
  } = source;
  return {
    ...card,
    url: gatewayUrl,
    supportedInterfaces: [{ ...selectedInterface, url: gatewayUrl }],
    securitySchemes: {
      flowlet: { httpAuthSecurityScheme: { scheme: "bearer" } },
    },
    security: [{ flowlet: [] }],
    securityRequirements: [{ schemes: { flowlet: { list: [] } } }],
    ...(Array.isArray(card.skills)
      ? {
          skills: card.skills.map((value) => {
            const {
              security: _oldSecurity,
              securityRequirements: _oldRequirements,
              ...skill
            } = asObject(value);
            return {
              ...skill,
              securityRequirements: [{ schemes: { flowlet: { list: [] } } }],
            };
          }),
        }
      : {}),
  };
}

export function validateAgentCard(card: JsonObject): void {
  const strings = (value: unknown) =>
    Array.isArray(value) && value.every((item) => typeof item === "string");
  if (
    typeof card.name !== "string" ||
    !card.name ||
    typeof card.description !== "string" ||
    typeof card.version !== "string" ||
    !card.capabilities ||
    !strings(card.defaultInputModes) ||
    !strings(card.defaultOutputModes) ||
    !Array.isArray(card.skills) ||
    card.skills.some((skill) => {
      const value = asObject(skill);
      return (
        typeof value.id !== "string" ||
        typeof value.name !== "string" ||
        typeof value.description !== "string" ||
        !strings(value.tags)
      );
    })
  )
    throw new Error(
      "Agent Card 缺少有效的名称、版本、能力、输入输出模式或技能声明",
    );

  const caps = asObject(card.capabilities);
  if (
    Object.keys(caps).length === 0 &&
    (typeof card.capabilities !== "object" || Array.isArray(card.capabilities))
  )
    throw new Error("Invalid Agent capabilities");
  for (const name of ["streaming", "pushNotifications", "extendedAgentCard"]) {
    if (caps[name] !== undefined && typeof caps[name] !== "boolean")
      throw new Error("Invalid Agent capability: " + name);
  }
  if (
    caps.extensions !== undefined &&
    (!Array.isArray(caps.extensions) ||
      caps.extensions.some((value) => {
        const ext = asObject(value);
        return (
          typeof ext.uri !== "string" ||
          !ext.uri ||
          (ext.required !== undefined && typeof ext.required !== "boolean")
        );
      }))
  )
    throw new Error("Invalid Agent extensions");
}
