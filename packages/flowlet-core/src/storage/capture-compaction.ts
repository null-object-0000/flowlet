import type { RequestCapturePointer, RequestCaptureRecord, RequestCaptureStore } from "./capture-store.ts";

export interface CaptureRewriteJob {
  storageKey: string;
  frames: Array<{ id: string; clear: boolean; pointer: RequestCapturePointer }>;
}

export interface CaptureRewrite {
  pointers: RequestCapturePointer[];
  bodyPresence: Array<{ req: boolean; res: boolean }>;
}

export function rewriteCaptureSegment(store: RequestCaptureStore, job: CaptureRewriteJob): CaptureRewrite {
  const bodyPresence: CaptureRewrite["bodyPresence"] = [];
  function* records(): Generator<RequestCaptureRecord> {
    for (const frame of job.frames) {
      const record = store.read(frame.pointer);
      bodyPresence.push({ req: record.req_body_b64 != null, res: record.res_body_b64 != null });
      if (frame.clear) {
        record.req_body_b64 = null;
        record.res_body_b64 = null;
      }
      yield record;
    }
  }
  const pointers = store.rewriteSegment(job.storageKey, records());
  return { pointers, bodyPresence };
}
