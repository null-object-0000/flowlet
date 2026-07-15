import { Button, Card, Space, Tag, Typography } from "@douyinfe/semi-ui-19";
import { IconTickCircle, IconClose } from "@douyinfe/semi-icons";
import { useProxyStatus } from "./useProxyStatus";
import { useProxyActions } from "./useProxyActions";
import { useProxyAutoStart } from "./useProxyAutoStart";
import { DEFAULT_BIND_ADDR } from "../../shared/constants/proxy";
import type { AppError } from "../../shared/errors/AppError";
import styles from "./ProxyStatusCard.module.css";

const { Text, Title } = Typography;

type Props = {
  /** Whether the app has finished its initial data load and may auto-start. */
  ready: boolean;
};

type StatusUi = {
  label: string;
  dotClass: string;
  color: "green" | "grey" | "red";
};

function renderStatusUi(running: boolean, startError: AppError | null): StatusUi {
  if (startError) return { label: "启动失败", dotClass: styles.dotFailed, color: "red" };
  if (running) return { label: "运行中", dotClass: styles.dotRunning, color: "green" };
  return { label: "已停止", dotClass: styles.dotStopped, color: "grey" };
}

/**
 * Proxy status overview card. Displays starting / running / stopped / failed
 * separately. Dense action rules (AGENTS.md §3):
 *   - running  → "重启服务"
 *   - stopped  → "启动服务"
 *   - failed   → "重新启动" + error reason
 * Pause/stop is intentionally NOT offered here (advanced entry only).
 */
export function ProxyStatusCard({ ready }: Props) {
  const status = useProxyStatus();
  const { restart } = useProxyActions();
  const auto = useProxyAutoStart({ enabled: ready });

  if (status.isLoading || !status.data) {
    return (
      <Card className={styles.card}>
        <Text type="tertiary">正在读取代理状态…</Text>
      </Card>
    );
  }

  const running = status.data.running;
  const startError = auto.startError;
  const ui = renderStatusUi(running, startError);
  const busy = auto.starting || restart.isPending;

  let actionLabel: string;
  if (auto.starting) {
    actionLabel = "正在启动…";
  } else if (running) {
    actionLabel = "重启服务";
  } else if (startError) {
    actionLabel = "重新启动";
  } else {
    actionLabel = "启动服务";
  }

  const onAction = () => {
    if (busy) return;
    if (running) {
      void restart.mutateAsync().catch(() => undefined);
    } else {
      // Stopped/failed: a single manual attempt. useProxyAutoStart already
      // guards the automatic attempt; this explicit tap is allowed to fail.
      void restart.mutateAsync().catch(() => undefined);
    }
  };

  return (
    <Card className={styles.card}>
      <div className={styles.headerRow}>
        <Title heading={5} style={{ margin: 0 }}>代理服务</Title>
        <Tag color={ui.color} size="small">
          <span className={`${styles.dot} ${ui.dotClass}`} /> {ui.label}
        </Tag>
      </div>

      <div className={styles.detail}>
        <Text type="tertiary" size="small">
          监听地址: {status.data.bind_addr || DEFAULT_BIND_ADDR}
        </Text>
        {status.data.started_at && running && (
          <Text type="tertiary" size="small">
            启动时间: {status.data.started_at}
          </Text>
        )}
      </div>

      {startError && (
        <div className={styles.error}>
          <Space spacing="tight" vertical align="start">
            <Text type="danger">
              <IconClose /> {startError.message}
            </Text>
            {startError.detail && (
              <Text type="tertiary" size="small">
                {startError.detail}
              </Text>
            )}
          </Space>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <Button
          theme="solid"
          type="primary"
          loading={busy}
          disabled={busy}
          icon={running ? <IconTickCircle /> : undefined}
          onClick={onAction}
        >
          {actionLabel}
        </Button>
      </div>
    </Card>
  );
}
