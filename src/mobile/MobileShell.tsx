import { IconDesktop, IconHome, IconList, IconSetting } from "@douyinfe/semi-icons";
import { MobileAppFrameView, type MobileNavItem } from "@flowlet/product-ui";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { MobileDeviceSyncAutoRefresh } from "../features/device-sync/MobileDeviceSyncAutoRefresh";
import { MobileDeviceSelectionProvider } from "./MobileDeviceSelection";

export function MobileShell() {
  const { t } = useAppPreferences();
  const navigate = useNavigate();
  const location = useLocation();
  const items: MobileNavItem[] = [
    { id: "/", href: "/", label: t("概览"), icon: <IconHome /> },
    { id: "/projects", href: "/projects", label: t("项目"), icon: <IconList /> },
    { id: "/devices", href: "/devices", label: t("设备"), icon: <IconDesktop /> },
    { id: "/settings", href: "/settings", label: t("设置"), icon: <IconSetting /> },
  ];
  const activeId = items.find((item) => item.id === "/" ? location.pathname === "/" : location.pathname.startsWith(item.id))?.id ?? "/";
  return (
    <MobileDeviceSelectionProvider>
      <MobileDeviceSyncAutoRefresh />
      <MobileAppFrameView
        items={items}
        activeId={activeId}
        navigationLabel={t("主导航")}
        onNavigate={(id) => navigate(id, { replace: true })}
      >
        <Outlet />
      </MobileAppFrameView>
    </MobileDeviceSelectionProvider>
  );
}
