// Test-only Windows signal driver. ChildProcess.kill("SIGINT") uses forced
// termination on Windows, so forward an IPC message to Node's signal event.
// The actual CLI installs and executes its own handler and cleanup unchanged.
process.once("message", (message) => {
  if (message !== "SIGINT" || process.listenerCount("SIGINT") === 0) {
    throw new Error("SIGINT test requires the CLI signal handler to be ready");
  }
  if (!process.disconnect) throw new Error("Signal test driver requires IPC");
  process.disconnect();
  process.emit("SIGINT");
});
// The test transport must not keep a gracefully finished CLI alive.
process.channel?.unref();

await import("../../cli.ts");

export {};
