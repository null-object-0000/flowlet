import { resolveUiVersion } from "./bootstrap/uiVersion";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Flowlet root element was not found");
}

async function renderLegacyApp() {
  const { renderApp } = await import("./legacy-main");
  renderApp(root as HTMLElement);
}

async function bootstrap() {
  const uiVersion = await resolveUiVersion(__FLOWLET_UI_FALLBACK__);

  if (uiVersion === "next") {
    try {
      const { renderApp } = await import("../src-new/main");
      renderApp(root as HTMLElement);
      return;
    } catch (error) {
      console.error("Failed to load the next UI; falling back to legacy.", error);
    }
  }

  await renderLegacyApp();
}

void bootstrap();