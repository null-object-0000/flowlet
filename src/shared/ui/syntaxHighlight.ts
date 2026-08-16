import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import langBash from "shiki/dist/langs/shellscript.mjs";
import langJson from "shiki/dist/langs/json.mjs";
import langTs from "shiki/dist/langs/typescript.mjs";

/** 与上游 MarkdownText 相同的 JS 正则引擎 + css-variables 主题（无 WASM 依赖）。 */
const theme = createCssVariablesTheme({ variablePrefix: "--shiki-" });

// 语言模块导出的是「注册数组」（每个模块可含多个相关语言）。
const bootLanguageRegistrations = [langTs, langBash, langJson].flat();

/** 常用且实际出现的语言做按需加载；其余回退纯文本。 */
const lazyLanguages: Record<string, () => Promise<unknown>> = {
  python: () => import("shiki/dist/langs/python.mjs").then((module) => module.default),
  rust: () => import("shiki/dist/langs/rust.mjs").then((module) => module.default),
  yaml: () => import("shiki/dist/langs/yaml.mjs").then((module) => module.default),
  sql: () => import("shiki/dist/langs/sql.mjs").then((module) => module.default),
  css: () => import("shiki/dist/langs/css.mjs").then((module) => module.default),
  html: () => import("shiki/dist/langs/html.mjs").then((module) => module.default),
  markdown: () => import("shiki/dist/langs/markdown.mjs").then((module) => module.default),
  c: () => import("shiki/dist/langs/c.mjs").then((module) => module.default),
  cpp: () => import("shiki/dist/langs/cpp.mjs").then((module) => module.default),
  csharp: () => import("shiki/dist/langs/csharp.mjs").then((module) => module.default),
  java: () => import("shiki/dist/langs/java.mjs").then((module) => module.default),
  go: () => import("shiki/dist/langs/go.mjs").then((module) => module.default),
  php: () => import("shiki/dist/langs/php.mjs").then((module) => module.default),
  ruby: () => import("shiki/dist/langs/ruby.mjs").then((module) => module.default),
  vue: () => import("shiki/dist/langs/vue.mjs").then((module) => module.default),
  docker: () => import("shiki/dist/langs/docker.mjs").then((module) => module.default),
};

/** 语言别名归一化，避免别名抖动导致重复加载。 */
const languageAliases: Record<string, string> = {
  js: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "typescript",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  py: "python",
  rs: "rust",
  yml: "yaml",
  gql: "graphql",
};

let highlighterPromise: Promise<HighlighterCore> | null = null;
const loading: Set<string> = new Set();
const loaded: Set<string> = new Set(bootLanguageRegistrations.map((entry) => entry.name));

function highlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [theme],
    langs: bootLanguageRegistrations as never,
    engine: createJavaScriptRegexEngine(),
  });
  return highlighterPromise;
}

function canonical(language: string | undefined | null): string | null {
  if (!language) return null;
  const alias = languageAliases[language.toLowerCase()];
  return alias ?? language.toLowerCase();
}

/**
 * 返回指定语言的静态高亮 HTML（css-variables 主题）。语言未加载或加载失败时返回 null，
 * 调用方回退到纯文本 `<pre><code>`。必须先 await `ensureLanguage` 再调用。
 */
export async function highlightToHtml(code: string, language: string | undefined | null): Promise<string | null> {
  const lang = canonical(language);
  if (!lang) return null;
  const core = await highlighter();
  if (!loaded.has(lang)) return null;
  try {
    return core.codeToHtml(code, { lang, theme: "css-variables", defaultColor: false });
  } catch {
    return null;
  }
}

/** 确保语言已加载（幂等；并行调用共享同一 promise）。 */
export async function ensureLanguage(language: string | undefined | null): Promise<void> {
  const lang = canonical(language);
  if (!lang || loaded.has(lang)) return;
  const loader = lazyLanguages[lang] ?? lazyLanguages[languageAliases[lang] ?? ""];
  if (!loader || loading.has(lang)) return;
  loading.add(lang);
  try {
    const grammar = await loader();
    const core = await highlighter();
    await core.loadLanguage(grammar as never);
    loaded.add(lang);
  } catch {
    // 语法加载失败：保持纯文本回退。
  } finally {
    loading.delete(lang);
  }
}