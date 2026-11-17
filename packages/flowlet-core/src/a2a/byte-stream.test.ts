import assert from "node:assert/strict";
import { test } from "node:test";
import { byteStream } from "./byte-stream.ts";

test("byte stream preserves chunks and completes", async () => {
  async function* input() {
    yield Buffer.from("hello");
    yield Buffer.from(" world");
  }
  assert.equal(await new Response(byteStream(input())).text(), "hello world");
});

test("byte stream forwards source errors", async () => {
  async function* input(): AsyncGenerator<Uint8Array> {
    throw new Error("source failed");
  }
  await assert.rejects(new Response(byteStream(input())).text(), /source failed/);
});

test("byte stream cancellation closes the upstream iterator", async () => {
  let closed = false;
  async function* input() {
    try {
      yield Buffer.from("chunk");
      yield Buffer.from("later");
    } finally {
      closed = true;
    }
  }
  const reader = byteStream(input()).getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(closed, true);
});
