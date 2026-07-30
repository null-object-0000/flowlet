import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

type MobileDeviceSelectionValue = {
  deviceId: string | null;
  setDeviceId: (deviceId: string | null) => void;
};

const MobileDeviceSelectionContext = createContext<MobileDeviceSelectionValue | null>(null);

export function MobileDeviceSelectionProvider({ children }: { children: ReactNode }) {
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const value = useMemo(() => ({ deviceId, setDeviceId }), [deviceId]);
  return (
    <MobileDeviceSelectionContext.Provider value={value}>
      {children}
    </MobileDeviceSelectionContext.Provider>
  );
}

export function useMobileDeviceSelection() {
  const value = useContext(MobileDeviceSelectionContext);
  if (!value) throw new Error("useMobileDeviceSelection must be used inside MobileDeviceSelectionProvider");
  return value;
}
