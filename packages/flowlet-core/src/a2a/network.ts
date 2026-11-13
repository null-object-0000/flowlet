import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent, request } from "undici";

const privateAddresses = new BlockList();
for (const [ip, prefix] of [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["100.64.0.0", 10],
] as const)
  privateAddresses.addSubnet(ip, prefix);
privateAddresses.addAddress("::1", "ipv6");
privateAddresses.addSubnet("fc00::", 7, "ipv6");
privateAddresses.addSubnet("fec0::", 10, "ipv6");
privateAddresses.addSubnet("198.18.0.0", 15);
const forbidden = new BlockList();
const forbiddenV6 = new BlockList();
forbidden.addAddress("100.100.100.200");
forbiddenV6.addAddress("fd00:ec2::254", "ipv6");
forbiddenV6.addSubnet("2001::", 32, "ipv6");
for (const [ip, prefix] of [
  ["0.0.0.0", 8],
  ["169.254.0.0", 16],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  forbidden.addSubnet(ip, prefix);
forbiddenV6.addAddress("::", "ipv6");
forbiddenV6.addSubnet("fe80::", 10, "ipv6");
forbiddenV6.addSubnet("ff00::", 8, "ipv6");
// IPv4-in-IPv6 and translation/tunnel ranges are rejected, rather than bypassing IPv4 checks.
forbiddenV6.addSubnet("::", 96, "ipv6");
forbiddenV6.addSubnet("::ffff:0:0", 96, "ipv6");
forbiddenV6.addSubnet("64:ff9b::", 96, "ipv6");
forbiddenV6.addSubnet("2002::", 16, "ipv6");

export function validateAddress(ip: string, allowPrivate: boolean): void {
  const family = isIP(ip) === 6 ? "ipv6" : "ipv4";
  if (
    !isIP(ip) ||
    (family === "ipv6" ? forbiddenV6 : forbidden).check(ip, family)
  )
    throw new Error("A2A 不允许访问链路本地、元数据或保留地址");
  if (!allowPrivate && privateAddresses.check(ip, family))
    throw new Error("该 Agent 使用内网地址，请显式允许内网访问");
}

export function parseHttpUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.hash ||
    url.search
  ) {
    throw new Error("A2A 地址必须为不含账号、查询参数与锚点的 HTTP(S) URL");
  }
  return url;
}

/** Resolve, validate and pin the actual connection. Redirects never inherit credentials. */
export async function a2aRequest(
  urlText: string,
  options: {
    allowPrivate: boolean;
    token?: string;
    body?: string;
    extensions?: string;
    signal: AbortSignal;
  },
) {
  const url = parseHttpUrl(urlText);
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length) throw new Error("A2A 地址无法解析");
  for (const item of addresses)
    validateAddress(item.address, options.allowPrivate);
  const pinned = addresses[0];
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, opts, callback) => {
        if (opts.all)
          callback(null, [{ address: pinned.address, family: pinned.family }]);
        else callback(null, pinned.address, pinned.family);
      },
    },
  });
  try {
    const result = await request(url, {
      dispatcher,
      method: options.body === undefined ? "GET" : "POST",
      signal: options.signal,
      headersTimeout: 30_000,
      bodyTimeout: 0,
      headers: {
        accept: "application/json, text/event-stream",
        "accept-encoding": "identity",
        "a2a-version": "1.0",
        ...(options.extensions ? { "a2a-extensions": options.extensions } : {}),
        ...(options.body === undefined
          ? {}
          : { "content-type": "application/json" }),
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      body: options.body,
    });
    // Explicit cleanup of a rejected card/status may destroy an unread body.
    // Iterators still receive read errors; this handles the accompanying stream event.
    result.body.on("error", () => {});
    return { ...result, close: () => dispatcher.close() };
  } catch (error) {
    await dispatcher.destroy();
    throw error;
  }
}

export async function readLimited(
  body: AsyncIterable<Uint8Array>,
  limit: number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) throw new Error("A2A 响应超过大小限制");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
