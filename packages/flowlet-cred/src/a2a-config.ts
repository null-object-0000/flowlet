import { CredentialStore } from "./store.ts";

export interface A2aConfig {
  url: string;
  token: string;
}

/** Read URL/token as a pair, never mixing an environment override with a stored secret. */
export function readA2aConfig(
  store: CredentialStore,
  prefix: string,
  env: NodeJS.ProcessEnv = process.env,
): A2aConfig {
  const urlKey = prefix + "_URL",
    tokenKey = prefix + "_TOKEN";
  const envUrl = env[urlKey],
    envToken = env[tokenKey];
  if ((envUrl !== undefined) !== (envToken !== undefined))
    throw new Error(
      `环境变量 ${urlKey}/${tokenKey} 必须成对提供，不能与凭据库混用`,
    );
  const stored = envUrl === undefined ? new Map(store.pairs()) : undefined;
  const url = (envUrl ?? stored?.get(urlKey))?.trim(),
    token = (envToken ?? stored?.get(tokenKey))?.trim();
  if (!url || !token)
    throw new Error(
      `缺少 ${urlKey}/${tokenKey}；请先 flowlet login / flowlet pull，或指定已有 --prefix`,
    );
  return { url, token };
}

/** Only the explicit A2A namespace is auto-probed, not every unrelated HTTP credential. */
export function a2aPrefixes(
  store: CredentialStore,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const prefixes = new Set<string>();
  for (const key of new Set([...store.keys(), ...Object.keys(env)])) {
    const match = /^(FLOWLET_A2A(?:_[A-Z0-9_]+)?)_(URL|TOKEN)$/.exec(key);
    if (match) prefixes.add(match[1]);
  }
  return [...prefixes].sort();
}
export function a2aSelection(prefix: string): {
  profile: string | null;
  selector: string[];
} {
  if (prefix === "FLOWLET_A2A") return { profile: null, selector: [] };
  const match = /^FLOWLET_A2A_([A-Z][A-Z0-9_]*)$/.exec(prefix);
  return match
    ? { profile: match[1], selector: ["--profile=" + match[1]] }
    : { profile: null, selector: ["--prefix=" + prefix] };
}
