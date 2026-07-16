import { describe, expect, it } from "vitest";
import type { ChannelAccount } from "../account/types";
import { deriveConfigurationStatus, type RouteCandidate } from "./types";

const account = { id: "account-1", enabled: true, api_key: "secret" } as ChannelAccount;
const route = { account_id: account.id, enabled: true } as RouteCandidate;

describe("deriveConfigurationStatus", () => {
  it("is unconfigured without a usable account", () => {
    expect(deriveConfigurationStatus([{ ...account, api_key: "" }], [route])).toBe("unconfigured");
  });

  it("requires an enabled model bound to a usable account", () => {
    expect(deriveConfigurationStatus([account], [{ ...route, account_id: "missing" }])).toBe("no_models");
    expect(deriveConfigurationStatus([account], [{ ...route, enabled: false }])).toBe("no_models");
  });

  it("is ready when an enabled route has a usable account", () => {
    expect(deriveConfigurationStatus([account], [route])).toBe("ready");
  });
});
