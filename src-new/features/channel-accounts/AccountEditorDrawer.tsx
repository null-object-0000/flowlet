import { Button, Input, Modal, Radio, RadioGroup, Select, Space, Typography } from "@douyinfe/semi-ui-19";
import { IconLink } from "@douyinfe/semi-icons";
import { useEffect, useState } from "react";
import { toAppError } from "../../platform/tauri/client";
import type { ChannelAccount } from "../../domains/account/types";
import type { ChannelPreset } from "../../domains/channel/types";
import styles from "./AccountEditorDrawer.module.css";

const { Text, Title } = Typography;

type Mode = { kind: "create"; channelId: string } | { kind: "edit"; account: ChannelAccount };

export type AccountEditorMode = Mode;

type TestInput = {
  channel_id: string;
  api_key: string;
  base_url_override?: string | null;
};

type Props = {
  visible: boolean;
  mode: Mode | null;
  presets: ChannelPreset[];
  onClose: () => void;
  onSave: (account: ChannelAccount) => Promise<void>;
  onTestConnection: (input: TestInput) => Promise<void>;
};

export function AccountEditorDrawer({
  visible,
  mode,
  presets,
  onClose,
  onSave,
  onTestConnection,
}: Props) {
  const [draft, setDraft] = useState<ChannelAccount | null>(null);
  const [testing, setTesting] = useState(false);
  const [notice, setNotice] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!visible || !mode) return;
    setNotice(null);
    if (mode.kind === "create") {
      const preset = presets.find((p) => p.id === mode.channelId);
      setDraft({
        id: `account-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel_id: mode.channelId,
        name: `${preset?.name ?? ""} 账号`,
        api_key: "",
        enabled: true,
        priority: 0,
        remark: "",
        resource_mode: null,
        base_url_override: null,
        last_used_at: null,
        last_error: null,
        credential_status: "healthy",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    } else {
      setDraft({ ...mode.account, api_key: "" });
    }
  }, [visible, mode, presets]);

  if (!visible || !mode || !draft) return null;

  const isEdit = mode.kind === "edit";

  function update<K extends keyof ChannelAccount>(key: K, value: ChannelAccount[K]) {
    setDraft((d) => (d ? { ...d, [key]: value, updated_at: new Date().toISOString() } : d));
  }

  const channel = presets.find((p) => p.id === draft.channel_id);

  const handleTest = async () => {
    if (!draft.api_key.trim()) {
      setNotice({ kind: "err", msg: "请先填写 API Key" });
      return;
    }
    setTesting(true);
    setNotice(null);
    try {
      await onTestConnection({
        channel_id: draft.channel_id,
        api_key: draft.api_key.trim(),
        base_url_override: draft.base_url_override,
      });
      setNotice({ kind: "ok", msg: "连接成功！API Key 有效" });
    } catch (err) {
      setNotice({ kind: "err", msg: toAppError(err, "account_test_failed").message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    if (!draft.name.trim()) {
      setNotice({ kind: "err", msg: "请填写账号名称" });
      return;
    }
    if (!isEdit && !draft.api_key.trim()) {
      setNotice({ kind: "err", msg: "请填写 API Key" });
      return;
    }
    setSaving(true);
    setNotice(null);
    await onSave(draft);
    setSaving(false);
  };

  return (
    <Modal
      title={isEdit ? "编辑账号" : "添加账号"}
      visible={visible}
      onCancel={onClose}
      footer={null}
      closeOnEsc
      maskClosable
      style={{ width: 520 }}
    >
      <div className={styles.form}>
        <Field label="所属渠道">
          <Select
            value={draft.channel_id}
            disabled={isEdit}
            onChange={(v) => update("channel_id", String(v))}
            optionList={presets.map((p) => ({ value: p.id, label: p.name }))}
            style={{ width: "100%" }}
          />
        </Field>

        <Field label="账号名称">
          <Input value={draft.name} onChange={(v) => update("name", v)} showClear />
        </Field>

        <Field label={isEdit ? "API Key（留空则不修改）" : "API Key"}>
          <Input
            placeholder={isEdit ? "••••••••" : "输入 API Key"}
            value={draft.api_key}
            onChange={(v) => update("api_key", v)}
            mode="password"
          />
        </Field>

        <Field label="自定义 Base URL（可选）">
          <Input
            placeholder={channel?.openai_base_url}
            value={draft.base_url_override ?? ""}
            onChange={(v) => update("base_url_override", v || null)}
            showClear
          />
        </Field>

        <Field label="启用状态">
          <RadioGroup
            value={draft.enabled ? "on" : "off"}
            onChange={(e) => update("enabled", e.target.value === "on")}
            direction="horizontal"
          >
            <Radio value="on">启用</Radio>
            <Radio value="off">停用</Radio>
          </RadioGroup>
        </Field>

        {channel?.platform_url && (
          <Text type="tertiary" size="small" className={styles.field}>
            <IconLink /> 获取 API Key：
            <a href={channel.platform_url} target="_blank" rel="noreferrer">
              {channel.name} 控制台
            </a>
          </Text>
        )}

        {notice && (
          <div className={styles.field}>
            <Text type={notice.kind === "ok" ? "success" : "danger"}>{notice.msg}</Text>
          </div>
        )}

        <Space className={styles.actions}>
          <Button onClick={onClose}>取消</Button>
          <Button theme="solid" type="primary" loading={saving} onClick={handleSave}>
            保存
          </Button>
          <Button onClick={handleTest} loading={testing}>
            测试连接
          </Button>
        </Space>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className={styles.field}>
      <Text className={styles.label}>{label}</Text>
      {children}
    </div>
  );
}
