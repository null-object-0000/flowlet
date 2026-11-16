import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(
  new URL("../packages/flowlet-agent-bridge/", import.meta.url),
);
function go(args) {
  const result = spawnSync("go", args, {
    cwd: root,
    env: { ...process.env, CGO_ENABLED: "0" },
    encoding: "utf8",
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr);
  return result.stdout;
}
mkdirSync(join(root, "bin"), { recursive: true });
const extension =
  (process.env.GOOS || process.platform) === "windows" ||
  (!process.env.GOOS && process.platform === "win32")
    ? ".exe"
    : "";
go(["build", "-trimpath", "-o", "bin/flowlet-agent-bridge" + extension, "."]);
// Preserve licenses of every compiled Go dependency in redistributable packages.
for (const line of go(["list", "-m", "-f", "{{.Path}}\t{{.Dir}}", "all"])
  .trim()
  .split("\n")) {
  const [name, directory] = line.split("\t");
  if (!directory || directory === root.replace(/\/$/, "")) continue;
  const target = join(root, "bin/licenses", name);
  for (const file of readdirSync(directory, { withFileTypes: true })) {
    if (file.isFile() && /^(license|copying|notice)(\.|$)/i.test(file.name)) {
      mkdirSync(target, { recursive: true });
      cpSync(join(directory, file.name), join(target, file.name));
    }
  }
}
console.log("[build-agent-bridge] ACP runtime and dependency licenses built");
