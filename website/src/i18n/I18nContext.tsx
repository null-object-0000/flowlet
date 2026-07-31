import { createContext, useContext, useEffect, type ReactNode } from "react";
import { en } from "./en";
import { zh, type Messages } from "./zh";

export type Lang = "zh" | "en";

export const LANGS: Lang[] = ["zh", "en"];

const dictionaries: Record<Lang, Messages> = { zh, en };

interface I18nValue {
  lang: Lang;
  t: Messages;
}

const I18nContext = createContext<I18nValue>({ lang: "zh", t: zh });

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }) {
  const t = dictionaries[lang];

  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    document.title = t.meta.title;
    document
      .querySelector('meta[name="description"]')
      ?.setAttribute("content", t.meta.description);
  }, [lang, t]);

  return <I18nContext.Provider value={{ lang, t }}>{children}</I18nContext.Provider>;
}

export function useI18n(): I18nValue {
  return useContext(I18nContext);
}
