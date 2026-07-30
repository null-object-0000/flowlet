import { IconRefresh } from "@douyinfe/semi-icons";
import { Button, Toast } from "@douyinfe/semi-ui-19";
import { useAppPreferences } from "../app/preferences/AppPreferences";
import { useMobileDeviceSyncActions, useMobileS3Settings } from "../features/device-sync/useMobileDeviceSync";
import { errorMessage } from "../shared/errors/AppError";

export function MobileRefreshButton() {
  const { t } = useAppPreferences();
  const settings = useMobileS3Settings();
  const actions = useMobileDeviceSyncActions();

  const refresh = async () => {
    try {
      await actions.refreshS3.mutateAsync();
    } catch (error) {
      Toast.error(t("刷新失败：{message}", { message: errorMessage(error) }));
    }
  };

  return (
    <Button
      theme="borderless"
      size="small"
      icon={<IconRefresh />}
      loading={actions.refreshS3.isPending}
      disabled={!settings.data?.config}
      aria-label={t("刷新")}
      onClick={() => void refresh()}
    />
  );
}
