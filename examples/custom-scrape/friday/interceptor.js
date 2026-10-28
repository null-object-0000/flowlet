(() => {
  if (window.location.origin !== "https://friday.17usoft.com") return;
  if (window.__flowlet_friday_interceptor_installed) return;
  window.__flowlet_friday_interceptor_installed = true;
  const matches = (input) => {
    try {
      const url = new URL(input, window.location.href);
      return url.origin === window.location.origin
        && /^\/api\/authing\/v2\/workspaces\/[^/]+\/api-keys\/?$/.test(url.pathname);
    } catch (_) { return false; }
  };
  const stash = (url, body) => {
    const items = window.__flowlet_scrape_stash ||= [];
    items.push({ url, body });
    if (items.length > 8) items.splice(0, items.length - 8);
    Promise.resolve().then(() => window.__TAURI_INTERNALS__?.invoke?.(
      "handle_intercepted_response", { channelId: "custom", url, body },
    )).catch(() => {});
  };
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    // 抓取异常不能改变页面自身 fetch 的成功/失败结果。
    try {
      const url = new URL(args[0]?.url ?? args[0], window.location.href).href;
      if (matches(url)) response.clone().text().then(body => stash(url, body)).catch(() => {});
    } catch (_) {}
    return response;
  };
  // 保留原生构造器、原型、静态常量和 instanceof 语义。
  const urls = new WeakMap();
  const listening = new WeakSet();
  const originalOpen = window.XMLHttpRequest.prototype.open;
  window.XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const result = originalOpen.call(this, method, url, ...rest);
    urls.set(this, new URL(url, window.location.href).href);
    if (!listening.has(this)) {
      listening.add(this);
      this.addEventListener("load", () => {
        try {
          const url = urls.get(this);
          if (matches(url) && (!this.responseType || this.responseType === "text")) {
            stash(url, this.responseText);
          }
        } catch (_) {}
      });
    }
    return result;
  };
})();
