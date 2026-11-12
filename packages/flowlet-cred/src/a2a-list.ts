import { A2aClient, a2aUrl, object } from "./a2a.ts";
import { a2aPrefixes, a2aSelection, readA2aConfig } from "./a2a-config.ts";
import { CredentialStore } from "./store.ts";

export interface A2aListOptions {
  prefix?: string;
  timeoutSeconds: number;
  signal: AbortSignal;
  insecure?: boolean;
  extensions?: string;
  cardUrl?: string;
}
export interface A2aListEntry {
  profile: string | null;
  prefix: string;
  available: boolean;
  url?: string;
  name?: string;
  description?: string;
  version?: string;
  skills: Array<{
    id: string;
    name: string;
    description?: string;
    tags: string[];
  }>;
  invoke: { command: string; args: string[] };
  error?: string;
}

export async function listA2aAgents(
  store: CredentialStore,
  options: A2aListOptions,
) {
  const prefixes = options.prefix ? [options.prefix] : a2aPrefixes(store);
  const agents: Array<A2aListEntry> = new Array(prefixes.length);
  let cursor = 0;
  // A failed/timed out peer does not cancel other discovery requests. Bound socket fan-out.
  const worker = async () => {
    while (cursor < prefixes.length && !options.signal.aborted) {
      const index = cursor++,
        prefix = prefixes[index];
      const selected = a2aSelection(prefix);
      const entry: A2aListEntry = {
        profile: selected.profile,
        prefix,
        available: false,
        skills: [],
        invoke: {
          command: "flowlet",
          args: ["a2a", "send", "<message>", ...selected.selector],
        },
      };
      agents[index] = entry;
      let client: A2aClient | undefined;
      const timeout = AbortSignal.timeout(options.timeoutSeconds * 1000);
      try {
        if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(prefix))
          throw new Error("A2A 凭据前缀无效");
        const config = readA2aConfig(store, prefix);
        // Validate before displaying a URL, so malformed URLs cannot disclose embedded credentials.
        entry.url = a2aUrl(config.url).href;
        client = new A2aClient(config.url, config.token, {
          signal: AbortSignal.any([options.signal, timeout]),
          insecure: options.insecure,
          extensions: options.extensions,
        });
        const card = await client.discover(options.cardUrl);
        const clean = (value: unknown) => client!.clean(String(value));
        entry.name = clean(card.name);
        if (typeof card.description === "string")
          entry.description = clean(card.description);
        if (typeof card.version === "string")
          entry.version = clean(card.version);
        entry.skills = (Array.isArray(card.skills) ? card.skills : [])
          .map(object)
          .filter(
            (skill) =>
              typeof skill.id === "string" && typeof skill.name === "string",
          )
          .map((skill) => ({
            id: clean(skill.id),
            name: clean(skill.name),
            ...(typeof skill.description === "string"
              ? { description: clean(skill.description) }
              : {}),
            tags: (Array.isArray(skill.tags) ? skill.tags : [])
              .filter((tag): tag is string => typeof tag === "string")
              .map(clean),
          }));
        entry.available = true;
      } catch (error) {
        entry.error = timeout.aborted
          ? "读取 Agent Card 超时"
          : client
            ? client.clean(error)
            : error instanceof Error
              ? error.message
              : String(error);
      } finally {
        if (client)
          await client.close().catch((error) => {
            entry.available = false;
            entry.error = client!.clean(error);
          });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, prefixes.length) }, worker),
  );
  if (options.signal.aborted) throw new Error("A2A 发现已中断");
  const available = agents.filter((agent) => agent.available).length;
  return {
    agents,
    total: agents.length,
    available,
    unavailable: agents.length - available,
    ...(agents.length
      ? {}
      : {
          hint: "尚无 A2A 配置；请先 flowlet login / flowlet pull，同步 FLOWLET_A2A[_PROFILE]_URL / _TOKEN，或用 --prefix 指定已有配置",
        }),
  };
}
