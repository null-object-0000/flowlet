import { describe, expect, it } from "vitest";
import { queryKeys } from "./query-keys";

describe("queryKeys", () => {
  it("keeps the models-cn document and derived currencies in separate caches", () => {
    expect(queryKeys.modelCatalog.catalog()).not.toEqual(
      queryKeys.modelCatalog.currencies(),
    );
  });

  it("keeps models-cn and models.dev documents in separate caches", () => {
    expect(queryKeys.modelCatalog.catalog()).not.toEqual(
      queryKeys.modelCatalog.modelsDevCatalog(),
    );
  });
});
