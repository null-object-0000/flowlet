import { invokeCommand, toAppError } from "../../platform/tauri/client";
import type {
  CredentialCheck,
  CredentialProvider,
  ServiceCredential,
  ServiceCredentialInput,
} from "./types";

/** 服务凭据命令适配器：页面/feature 不直接拼命令名。 */

function toAppErr(code: string) {
  return (err: unknown) => {
    throw toAppError(err, code);
  };
}

export const credentialCommands = {
  listProviders: (): Promise<CredentialProvider[]> =>
    invokeCommand<CredentialProvider[]>("list_credential_providers").catch(
      toAppErr("credential_providers_failed"),
    ),

  list: (): Promise<ServiceCredential[]> =>
    invokeCommand<ServiceCredential[]>("list_service_credentials").catch(
      toAppErr("credential_list_failed"),
    ),

  /**
   * 保存即校验：服务端会先调一次上游（GitLab `/user`），失败时不落库。
   * `insecure` 用于内网自签证书，逐次显式传入，不持久化。
   */
  save: (input: ServiceCredentialInput, insecure = false): Promise<ServiceCredential> =>
    invokeCommand<ServiceCredential>("save_service_credential", { input, insecure }).catch(
      toAppErr("credential_save_failed"),
    ),

  test: (id: string, insecure = false): Promise<CredentialCheck> =>
    invokeCommand<CredentialCheck>("test_service_credential", { id, insecure }).catch(
      toAppErr("credential_test_failed"),
    ),

  remove: (id: string): Promise<void> =>
    invokeCommand<void>("delete_service_credential", { id }).catch(toAppErr("credential_delete_failed")),
};