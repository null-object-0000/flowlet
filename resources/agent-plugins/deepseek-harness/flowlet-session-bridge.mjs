import { AsyncLocalStorage } from "node:async_hooks";

const SESSION_HEADER = "x-flowlet-session";
const sessions = new AsyncLocalStorage();

function normalizedBaseUrl(value) {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url;
}

function matchesBaseUrl(input, baseUrl) {
  try {
    const value = input instanceof Request ? input.url : String(input);
    const url = new URL(value);
    if (url.origin !== baseUrl.origin) return false;
    const basePath = baseUrl.pathname;
    return url.pathname === basePath || url.pathname.startsWith(`${basePath}/`);
  } catch {
    return false;
  }
}

function withSessionHeader(input, init, sessionId) {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(SESSION_HEADER, sessionId);
  if (input instanceof Request) {
    return [new Request(input, { ...init, headers }), undefined];
  }
  return [input, { ...init, headers }];
}

async function* withinSession(next, context) {
  const iterable = sessions.run(context, next);
  const iterator = iterable[Symbol.asyncIterator]();
  let completed = false;
  try {
    while (true) {
      const item = await sessions.run(context, () => iterator.next());
      if (item.done) {
        completed = true;
        return;
      }
      yield item.value;
    }
  } finally {
    if (!completed && iterator.return) {
      await sessions.run(context, () => iterator.return());
    }
  }
}

export const inject = ["llm"];

export default function apply(ctx, config = {}) {
  const provider = config.provider ?? "flowlet";
  const baseUrl = normalizedBaseUrl(config.baseURL);
  const originalFetch = globalThis.fetch;
  if (typeof originalFetch !== "function") {
    throw new Error("Flowlet session bridge requires global fetch");
  }

  const wrappedFetch = function (input, init) {
    const context = sessions.getStore();
    if (!context || !matchesBaseUrl(input, context.baseUrl)) {
      return originalFetch.call(this, input, init);
    }
    const [nextInput, nextInit] = withSessionHeader(
      input,
      init,
      context.sessionId,
    );
    return originalFetch.call(this, nextInput, nextInit);
  };
  globalThis.fetch = wrappedFetch;
  ctx.effect(() => () => {
    if (globalThis.fetch === wrappedFetch) globalThis.fetch = originalFetch;
  });

  ctx.on("llm/stream", (options, next) => {
    if (options.provider !== provider || !options.sessionId) return next();
    return withinSession(next, {
      sessionId: String(options.sessionId),
      baseUrl,
    });
  });
}
