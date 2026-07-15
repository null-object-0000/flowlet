import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type { RequestLogClient, RequestLogFilter, RequestLogPage, RequestLogRow } from "./types";

export const requestLogCommands = {
  list: (filter: RequestLogFilter): Promise<RequestLogPage> =>
    invokeCommand<RequestLogPage>("list_request_logs", {
      filter: {
        page: filter.page,
        page_size: filter.pageSize,
        status: filter.status,
        client_id: filter.clientId,
        channel_id: filter.channelId,
        search: filter.search,
      },
    }).catch(toRequestLogError("request_log_list_failed")),

  clients: (): Promise<RequestLogClient[]> =>
    invokeCommand<RequestLogClient[]>("list_request_log_clients").catch(toRequestLogError("request_log_clients_failed")),

  detail: (requestId: string): Promise<RequestLogRow[]> =>
    invokeCommand<RequestLogRow[]>("get_request_log_detail", { requestId }).catch(toRequestLogError("request_log_detail_failed")),

  cleanup: (keepDays: number): Promise<[number, number]> =>
    invokeCommand<[number, number]>("cleanup_old_logs", { keepDays }).catch(toRequestLogError("request_log_cleanup_failed")),
};

function toRequestLogError(code: string) {
  return (error: unknown) => {
    throw toAppError(error, code);
  };
}
