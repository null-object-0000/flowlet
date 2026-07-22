let suspensionCount = 0;

/**
 * Temporarily suppress the product-level proxy auto-start effect while a
 * frontend-owned maintenance flow intentionally pauses the proxy.
 */
export function suspendProxyAutoStart(): () => void {
  suspensionCount += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    suspensionCount = Math.max(0, suspensionCount - 1);
  };
}

export function isProxyAutoStartSuspended(): boolean {
  return suspensionCount > 0;
}
