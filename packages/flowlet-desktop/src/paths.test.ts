import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import type * as PathsModule from "./paths.ts";

const require = createRequire(import.meta.url);

function pathsHarness(existing: Record<string, string> = {}) {
  const files = new Map(Object.entries(existing));
  const resources = resolve("/package-resources");
  const runtime = join(resources, "runtime");
  for (const file of ["config.json", "model-catalog.json"]) files.set(join(runtime, file), `bundled:${file}`);
  for (const file of ["models-cn.json", "models-dev.json"]) files.set(join(runtime, "resources", "catalogs", file), `bundled:${file}`);
  const exported: { exports: Partial<typeof PathsModule> } = { exports: {} };
  const code = transformSync(readFileSync(new URL("./paths.ts", import.meta.url), "utf8"), {
    loader: "ts", format: "cjs", define: { "import.meta.url": JSON.stringify(new URL("./paths.ts", import.meta.url).href) },
  }).code;
  runInNewContext(code, {
    module: exported,
    exports: exported.exports,
    console,
    process: { platform: "linux", env: { XDG_DATA_HOME: "/existing-app-data" }, resourcesPath: resources, cwd: () => "/no-legacy-database" },
    require: (id: string) => {
      if (id === "electron") return { app: { isPackaged: true, getAppPath: () => "/packaged-app" } };
      if (id === "node:fs") return {
        existsSync: (path: string) => files.has(path),
        mkdirSync: () => undefined,
        copyFileSync: (source: string, target: string) => { assert.ok(files.has(source), `missing bundled source ${source}`); files.set(target, files.get(source)!); },
        readFileSync: () => { throw new Error("not available"); },
      };
      return require(id);
    },
  });
  return { paths: exported.exports as typeof PathsModule, files, runtime };
}

test("first launch seeds catalogs from neutral bundled resources, retaining established data locations", () => {
  const { paths, files, runtime } = pathsHarness();
  const dataDir = resolve("/test", "flowlet-data");
  const resolved = paths.resolveDesktopPaths({ dataDirOverride: dataDir });
  assert.equal(resolved.dataDir, dataDir);
  assert.equal(resolved.dbPath, join(dataDir, "flowlet.sqlite"));
  assert.equal(resolved.webviewRoot, join(dataDir, "webview"));
  assert.equal(resolved.runtimeRoot, runtime);
  for (const file of ["config.json", "model-catalog.json", "models-cn.json", "models-dev.json"]) {
    assert.equal(files.get(join(dataDir, file)), `bundled:${file}`);
  }
});

test("resource migration never replaces existing user configuration or model snapshots", () => {
  const dataDir = resolve("/test", "existing-data");
  const existing = Object.fromEntries(["config.json", "model-catalog.json", "models-cn.json", "models-dev.json", "flowlet.sqlite"].map((file) => [join(dataDir, file), `user:${file}`]));
  const { paths, files } = pathsHarness(existing);
  paths.resolveDesktopPaths({ dataDirOverride: dataDir });
  for (const [file, contents] of Object.entries(existing)) assert.equal(files.get(file), contents);
});
