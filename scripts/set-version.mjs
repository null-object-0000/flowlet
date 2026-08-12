import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));
const nextVersion = process.argv[2];

if (!nextVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(nextVersion)) {
  throw new Error("用法：npm run version:set -- <semver>，例如 0.1.2");
}

function update(relativePath, transform) {
  const path = `${rootDir}${relativePath}`;
  const current = readFileSync(path, "utf8");
  const next = transform(current);
  if (next === current) return;
  writeFileSync(path, next, "utf8");
}

function replaceRequired(content, pattern, replacement, label) {
  const next = content.replace(pattern, replacement);
  if (next === content && !content.includes(replacement.replaceAll("$1", "").replaceAll("$2", ""))) {
    throw new Error(`无法更新 ${label}`);
  }
  return next;
}

update("package.json", (content) =>
  replaceRequired(content, /("version"\s*:\s*")[^"]+(")/, `$1${nextVersion}$2`, "package.json"),
);

update("package-lock.json", (content) => {
  let count = 0;
  const next = content.replace(/("version"\s*:\s*")[^"]+(")/g, (match, prefix, suffix) => {
    if (count >= 2) return match;
    count += 1;
    return `${prefix}${nextVersion}${suffix}`;
  });
  if (count !== 2) throw new Error("无法更新 package-lock.json 的根包版本");
  return next;
});

update("src-tauri/Cargo.toml", (content) =>
  replaceRequired(
    content,
    /(\[package\][\s\S]*?\bversion\s*=\s*")[^"]+(")/,
    `$1${nextVersion}$2`,
    "src-tauri/Cargo.toml",
  ),
);

update("src-tauri/Cargo.lock", (content) =>
  replaceRequired(
    content,
    /(\[\[package\]\]\s*\r?\nname\s*=\s*"flowlet"\s*\r?\nversion\s*=\s*")[^"]+(")/,
    `$1${nextVersion}$2`,
    "src-tauri/Cargo.lock",
  ),
);

console.log(`Flowlet 版本已同步为 ${nextVersion}`);
