import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AppError } from "../../shared/errors/AppError";
import type { ChannelPreset } from "./types";

/** 单条渠道预设变更项。 */
export type PresetDiffItem = {
  id: string;
  name: string;
  status: "added" | "removed" | "updated";
  before: string | null;
  after: string | null;
};

/** config.json 与数据库渠道预设的对比结果。 */
export type PresetSyncPreview = {
  hasChanges: boolean;
  addedCount: number;
  removedCount: number;
  updatedCount: number;
  items: PresetDiffItem[];
};

/** Channel-template command adapter. Templates are seeded from config.json on
 *  the Rust side and rarely mutated by the UI, but we expose a type-safe read
 *  path. No mutation for individual accounts lives here (see account/commands). */

export const channelCommands = {
  listPresets: (): Promise<ChannelPreset[]> =>
    invokeCommand<ChannelPreset[]>("list_channel_presets").catch((err) => {
      throw toAppError(err, "channel_list_failed");
    }),
  previewSyncPresets: (): Promise<PresetSyncPreview> =>
    invokeCommand<PresetSyncPreview>("preview_sync_channel_presets").catch((err) => {
      throw toAppError(err, "channel_sync_preview_failed");
    }),
  applySyncPresets: (): Promise<void> =>
    invokeCommand<void>("apply_sync_channel_presets").catch((err) => {
      throw toAppError(err, "channel_sync_apply_failed");
    }),
};
