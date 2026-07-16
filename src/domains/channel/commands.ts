import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { AppError } from "../../shared/errors/AppError";
import type { ChannelPreset } from "./types";

/** Channel-template command adapter. Templates are seeded from config.json on
 *  the Rust side and rarely mutated by the UI, but we expose a type-safe read
 *  path. No mutation for individual accounts lives here (see account/commands). */

export const channelCommands = {
  listPresets: (): Promise<ChannelPreset[]> =>
    invokeCommand<ChannelPreset[]>("list_channel_presets").catch((err) => {
      throw toAppError(err, "channel_list_failed");
    }),
};
