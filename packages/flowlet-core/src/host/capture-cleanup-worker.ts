import { parentPort, workerData } from "node:worker_threads";
import { RequestCaptureStore } from "../storage/capture-store.ts";
import { rewriteCaptureSegment, type CaptureRewriteJob } from "../storage/capture-compaction.ts";

const port = parentPort!;
const store = new RequestCaptureStore(workerData as string);
port.on("message", (job: CaptureRewriteJob) => {
  try {
    port.postMessage({ result: rewriteCaptureSegment(store, job) });
  } catch (error) {
    port.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
});
