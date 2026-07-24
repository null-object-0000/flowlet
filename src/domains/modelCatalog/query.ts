/** models-cn 本地文件读取层。
 *  数据由后台定时任务（sync_models_cn_catalog）拉取为 exe 旁的 models-cn.json 文件，
 *  前端只读本地文件内容，不直接请求远程。本地无数据时返回 undefined。 */

import { useQuery } from "@tanstack/react-query";
import { backgroundTaskCommands } from "../background-task/commands";
import { queryKeys } from "../../shared/query-keys";

/** 读取本地 models-cn.json 文件内容。
 *  - 文件不存在时 data 为 null（不展示 models-cn 相关内容）
 *  - 数据来自后台定时任务写入，前端不发起远程请求 */
export function useLocalModelsCnCatalog(): {
  data: string | null | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
} {
  const query = useQuery({
    queryKey: queryKeys.modelCatalog.catalog(),
    queryFn: backgroundTaskCommands.getModelsCnCatalog,
    staleTime: 5 * 60 * 1000,
    gcTime: 30 * 60 * 60_1000,
    refetchOnWindowFocus: false,
    retry: 1,
  });
  return {
    data: query.data,
    isLoading: query.isLoading,
    isError: query.isError,
    error: query.error instanceof Error ? query.error : null,
    refetch: () => void query.refetch(),
  };
}
