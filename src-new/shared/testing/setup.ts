import "@douyinfe/semi-ui-19/react19-adapter";
import "@testing-library/jest-dom/vitest";

class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

if (!("Worker" in globalThis)) Object.defineProperty(globalThis, "Worker", { value: TestWorker, configurable: true });
if (!("createObjectURL" in URL)) Object.defineProperty(URL, "createObjectURL", { value: () => "blob:flowlet-test-worker", configurable: true });
if (!("revokeObjectURL" in URL)) Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
