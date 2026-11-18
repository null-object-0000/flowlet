import { LocaleProvider } from "@douyinfe/semi-ui-19";
import enUS from "@douyinfe/semi-ui-19/lib/es/locale/source/en_US";
import zhCN from "@douyinfe/semi-ui-19/lib/es/locale/source/zh_CN";
import { Navigate, Route, Routes, useLocation } from "react-router-dom";
import { I18nProvider, type Lang } from "./i18n/I18nContext";
import { LandingPage } from "./LandingPage";

function detectLang(): Lang {
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

function LocalizedLanding({ lang }: { lang: Lang }) {
  return (
    <LocaleProvider locale={lang === "zh" ? zhCN : enUS}>
      <I18nProvider lang={lang}>
        <LandingPage />
      </I18nProvider>
    </LocaleProvider>
  );
}

function LocalizedRedirect() {
  const { hash } = useLocation();
  return <Navigate to={`/${detectLang()}${hash}`} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<LocalizedRedirect />} />
      <Route path="/zh" element={<LocalizedLanding lang="zh" />} />
      <Route path="/en" element={<LocalizedLanding lang="en" />} />
      <Route path="*" element={<LocalizedRedirect />} />
    </Routes>
  );
}
