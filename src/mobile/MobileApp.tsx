import { AppProviders } from "../app/providers";
import { MobileRouter } from "./MobileRouter";

export function MobileApp() {
  return (
    <AppProviders>
      <MobileRouter />
    </AppProviders>
  );
}
