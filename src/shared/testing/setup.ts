import "@testing-library/jest-dom/vitest";
import { vi } from "vitest";

vi.mock("lottie-web", () => ({
  default: { loadAnimation: vi.fn(() => ({ destroy: vi.fn() })) },
}));

Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
  configurable: true,
  value: () => ({ fillStyle: "", fillRect: vi.fn() }),
});

await import("@douyinfe/semi-ui-19/react19-adapter");

class TestWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  postMessage() {}
  terminate() {}
  addEventListener() {}
  removeEventListener() {}
  dispatchEvent() { return true; }
}

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

if (!("Worker" in globalThis)) Object.defineProperty(globalThis, "Worker", { value: TestWorker, configurable: true });
if (!("ResizeObserver" in globalThis)) Object.defineProperty(globalThis, "ResizeObserver", { value: TestResizeObserver, configurable: true });
if (!("createObjectURL" in URL)) Object.defineProperty(URL, "createObjectURL", { value: () => "blob:flowlet-test-worker", configurable: true });
if (!("revokeObjectURL" in URL)) Object.defineProperty(URL, "revokeObjectURL", { value: () => undefined, configurable: true });
