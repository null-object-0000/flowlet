import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { PropsWithChildren } from "react";
import { ErrorBoundary } from "../shared/errors/ErrorBoundary";
import { AppPreferencesProvider } from "./preferences/AppPreferences";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      networkMode: "always",
      refetchOnWindowFocus: false,
      retry: false,
    },
    mutations: {
      networkMode: "always",
      retry: false,
    },
  },
});

export function AppProviders({ children }: PropsWithChildren) {
  return (
    <ErrorBoundary>
      <AppPreferencesProvider>
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      </AppPreferencesProvider>
    </ErrorBoundary>
  );
}
