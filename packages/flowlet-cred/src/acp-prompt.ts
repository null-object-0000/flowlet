import type { ContentBlock } from "@agentclientprotocol/sdk";
function invalid(message: string): never { throw Object.assign(new Error(message), {code: -32602}); }

/** Native ACP only: forward caller-supplied bytes; never dereference URLs or local paths. */
export function nativePrompt(value: unknown, images: boolean): ContentBlock[] {
  if (!Array.isArray(value) || !value.length)
    invalid("Prompt is empty");
  for (const block of value) {
    if (block?.type === "text" && typeof block.text === "string") continue;
    if (
      images && block?.type === "image" &&
      typeof block.mimeType === "string" && /^image\/[a-z0-9.+-]+$/i.test(block.mimeType) &&
      typeof block.data === "string" && block.data.length > 0 &&
      block.data.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(block.data) &&
      Buffer.from(block.data, "base64").toString("base64") === block.data
    ) continue;
    invalid(
      "Remote ACP accepts text and inline images advertised by the upstream; URLs, files and other resources are not read",
    );
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 4 * 1024 * 1024 - 4096)
    invalid("Prompt exceeds the 4 MiB ACP transport limit");
  // Strip optional URI/metadata so no consumer can dereference client-supplied locations.
  return value.map((block) => block.type === "text"
    ? { type: "text", text: block.text }
    : { type: "image", data: block.data, mimeType: block.mimeType });
}
