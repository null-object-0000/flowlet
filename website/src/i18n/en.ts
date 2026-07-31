import type { Messages } from "./zh";

export const en: Messages = {
  meta: {
    title: "Flowlet — A local, observable, switchable model gateway for AI agents",
    description:
      "Flowlet is a local desktop model service console for AI agents: manage channels and accounts in one place, connect Claude Code, OpenCode, Pi and more through a local proxy, and inspect requests, sessions, tokens, cost and quota in a single desktop app.",
  },
  nav: {
    features: "Features",
    channels: "Channels",
    agents: "Agents",
    quickstart: "Quickstart",
    github: "GitHub",
  },
  hero: {
    badge: "Early Preview",
    title: "A local, observable, switchable model gateway for your AI agents.",
    subtitle:
      "Manage model channels and accounts in one place, connect Claude Code, OpenCode, Pi and other agents through a local proxy, and inspect requests, sessions, tokens, cost and quota in a single desktop app.",
    ctaGithub: "GitHub Repo",
    ctaQuickstart: "3-minute Quickstart",
    note: "Free & open source · MIT License · Tauri 2 desktop app",
  },
  features: {
    title: "Why Flowlet",
    subtitle:
      "AI agents are multiplying, but model channels, accounts, plans, request logs and session data are scattered everywhere. Flowlet brings these daily operations back to your local desktop.",
    items: [
      {
        title: "One local endpoint",
        desc: "OpenAI-compatible and Anthropic-compatible clients share a fixed Base URL and Client Token — no more swapping upstream keys in every agent.",
      },
      {
        title: "Multiple channels & accounts",
        desc: "Manage LongCat, DeepSeek, Kimi, Qwen and custom relay services, with multiple candidate accounts and priorities per model.",
      },
      {
        title: "Explicit model exposure",
        desc: "Pull the real /models list from upstream and only expose models that Flowlet supports and you explicitly select; non-whitelisted models stay visible but cannot be enabled by mistake.",
      },
      {
        title: "Agents are no longer black boxes",
        desc: "Inspect every request through Flowlet, plus native local sessions and timelines from Claude Code, OpenCode, Pi and Codex Desktop / CLI.",
      },
      {
        title: "Usage & cost made auditable",
        desc: "See tokens, cache hits, model prices, channel costs, plan quotas and Codex credits — different currencies and cost semantics are never force-added together.",
      },
      {
        title: "Local-first",
        desc: "Proxy, config, SQLite database and request captures stay on your machine by default; multi-device sharing is optional.",
      },
    ],
  },
  channels: {
    title: "Channels & Accounts",
    subtitle:
      "Add multiple accounts per channel, test connections, enable/disable and adjust route priorities; supports official balance, resource pack and plan quota queries.",
    table: {
      channel: "Channel",
      openai: "OpenAI Chat",
      anthropic: "Anthropic Messages",
      models: "Model Sync",
      balance: "Balance / Quota",
    },
    rows: [
      {
        name: "LongCat",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "Resource packs & pay-as-you-go",
      },
      {
        name: "DeepSeek",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "Official balance",
      },
      {
        name: "Kimi / Moonshot",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "Official balance",
      },
      {
        name: "Qwen",
        openai: "✅",
        anthropic: "✅",
        models: "✅",
        balance: "Token Plan quota",
      },
      {
        name: "Custom channel",
        openai: "Upstream dependent",
        anthropic: "Upstream dependent",
        models: "Standard OpenAI /models",
        balance: "—",
      },
    ],
    note: "Custom channels connect to standard OpenAI-compatible / Anthropic-compatible relay services; models must come from the account's real /models response.",
  },
  agents: {
    title: "One-click Agent Integration",
    subtitle:
      "Detect installations, write global configs, copy Base URL and Client Token; clicking an agent card opens the full integration guide — not just a copied address.",
    table: {
      agent: "Agent",
      detect: "Install Detection",
      connect: "One-click Connect",
      session: "Native Sessions",
    },
    rows: [
      { name: "Claude Code", detect: "✅", connect: "✅", session: "✅" },
      { name: "OpenCode CLI / Desktop", detect: "✅", connect: "✅", session: "✅" },
      { name: "Pi", detect: "✅", connect: "✅", session: "✅" },
      { name: "ChatGPT (Codex) / Codex CLI", detect: "✅", connect: "Not yet", session: "✅" },
    ],
    note: "Supports Claude Code main model, fast model, sub-agent models and the optional [1m] long context; OpenCode CLI and Desktop are both recognized.",
  },
  quickstart: {
    title: "3-minute Quickstart",
    subtitle: "Flowlet is in early preview. Running from source or building yourself is currently recommended.",
    requirements: "Requirements: Node.js 22+, Rust stable, Tauri 2 system dependencies.",
    stepsTitle: "After first launch",
    steps: [
      "Flowlet automatically tries to start the local proxy;",
      "Add a channel account on the Overview page and enter the upstream API Key;",
      "Click \"Fetch model list\", choose the models to expose and save;",
      "In \"AI Agent Access\", pick Claude Code, OpenCode or Pi and write the global config in one click;",
      "Go back to your agent, make requests, and inspect logs, sessions and usage in Flowlet.",
    ],
    endpointsTitle: "Local endpoints",
    endpointsNote: "The default proxy address is http://127.0.0.1:18640. Client authentication uses the Client Token shown on the Overview page — not a channel API Key.",
    endpoints: {
      usage: "Purpose",
      address: "Address",
      rows: [
        { usage: "Health check", address: "http://127.0.0.1:18640/health" },
        { usage: "OpenAI Base URL", address: "http://127.0.0.1:18640/v1" },
        { usage: "OpenAI model list", address: "http://127.0.0.1:18640/v1/models" },
        { usage: "OpenAI Chat Completions", address: "http://127.0.0.1:18640/v1/chat/completions" },
        { usage: "Anthropic Base URL", address: "http://127.0.0.1:18640/anthropic" },
        { usage: "Anthropic Messages", address: "http://127.0.0.1:18640/anthropic/v1/messages" },
      ],
    },
  },
  security: {
    title: "Data & Security",
    items: [
      "Channel API Keys, Client Tokens, configs and usage data stay on your machine by default;",
      "Request log redaction is controlled by log_capture.redact_sensitive_headers and is currently off by default;",
      "With defaults, request captures may store Authorization, x-api-key, Cookie, headers and bodies as-is;",
      "If you don't need full request debugging, enable sensitive-header redaction or disable header/body capture under Settings → Data Capture;",
      "Optional S3 device sync sends only minimal usage and session summaries — never request bodies, credentials or channel accounts;",
      "Flowlet's costs are estimates based on official price catalogs, not equivalent to actual bills or subscription amortization.",
    ],
  },
  boundaries: {
    title: "What Flowlet Doesn't Do",
    subtitle: "Flowlet is a local model service console for AI agents — not a generic enterprise LLM gateway.",
    items: [
      "No conversion between different model service protocols;",
      "No arbitrary rewriting of upstream response structures;",
      "No enterprise multi-tenancy, complex weight scheduling or large-scale gateway control planes;",
      "Fallback only handles retryable network errors, 429 and some 5xx — it never masks parameter errors by switching models;",
      "Agent-native usage and proxied requests are counted separately, never double-added.",
    ],
  },
  footer: {
    tagline: "A local, observable, switchable model gateway for AI agents.",
    links: "Links",
    docs: "Docs",
    license: "License",
    copyright: "© {year} Flowlet. MIT License.",
  },
  languageName: "English",
};
