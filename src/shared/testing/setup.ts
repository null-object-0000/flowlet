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

/**
 * Node 22+ 自带实验性 localStorage 全局，未带 --localstorage-file 时值为 undefined，
 * 且会阻止 vitest/jsdom 注入浏览器 Storage。这里在测试环境补一个内存实现，
 * 与 jsdom 行为一致（getItem/setItem/removeItem/clear/key/length）。
 */
function installMemoryStorage(name: "localStorage" | "sessionStorage") {
  if (typeof (globalThis as Record<string, unknown>)[name] !== "undefined") return;
  const store = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: () => store.clear(),
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, name, { value: storage, configurable: true });
}
installMemoryStorage("localStorage");
installMemoryStorage("sessionStorage");

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
