#!/usr/bin/env node
// Read-only audit of an extracted /app snapshot against a committed source tree.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";

const args = process.argv.slice(2);
function option(name, fallback) {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`Missing value for ${name}`);
  return args[i + 1];
}
if (args.includes("--help")) {
  console.log("node scripts/audit-release-parity.mjs --snapshot-dir <extracted-app> [--ref HEAD] [--ui-dir dist-web] [--report audit.json]\nExit 2 means differences require review. This command never modifies an application or contacts a service.");
  process.exit(0);
}
const snapshotArg = option("--snapshot-dir");
if (!snapshotArg) throw new Error("--snapshot-dir is required; use an extracted /app snapshot, without runtime credentials or /data");
const snapshot = path.resolve(snapshotArg);
const ref = execFileSync("git", ["rev-parse", option("--ref", "HEAD")], { encoding: "utf8" }).trim();
const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
const source = (file) => git("show", `${ref}:${file}`);
const sourceFiles = (prefix) => git("ls-tree", "-r", "--name-only", ref, prefix).trim().split("\n").filter(Boolean);
function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const file = path.join(dir, item.name);
    return item.isDirectory() ? walk(file) : [file];
  });
}
const isModule = (file) => /\.[cm]?[jt]sx?$/.test(file) && !file.includes("/__tests__/") && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file);
const printer = ts.createPrinter({ removeComments: true });
const syntax = (body, file) => printer.printFile(ts.createSourceFile(file, body, ts.ScriptTarget.Latest, true));
function runtime(body, file) {
  const result = ts.transpileModule(body, {
    fileName: file,
    reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext, removeComments: true, jsx: ts.JsxEmit.ReactJSX },
  });
  if (result.diagnostics?.length) throw new Error(`Cannot compare ${file}: ${result.diagnostics.map((d) => ts.flattenDiagnosticMessageText(d.messageText, " ")).join("; ")}`);
  return result.outputText;
}
const prefix = "packages/flowlet-core/src";
const local = sourceFiles(prefix).filter(isModule);
const online = walk(path.join(snapshot, prefix)).map((file) => path.relative(snapshot, file)).filter(isModule);
const report = {
  sourceRef: ref,
  counts: { localModules: local.length, onlineModules: online.length, identical: 0, commentsOnly: 0 },
  onlineOnly: online.filter((file) => !local.includes(file)),
  sourceOnly: local.filter((file) => !online.includes(file)),
  typeDifferences: [], runtimeDifferences: [], configurationDifferences: {},
};
// This legacy read-only PoC is not the production entrypoint (index.ts).
report.expectedSourceOnly = report.sourceOnly.filter((file) => file === "packages/flowlet-core/src/server.mjs");
report.unexpectedSourceOnly = report.sourceOnly.filter((file) => !report.expectedSourceOnly.includes(file));
for (const file of local.filter((file) => online.includes(file))) {
  const a = source(file), b = readFileSync(path.join(snapshot, file), "utf8");
  if (a === b) report.counts.identical++;
  else if (syntax(a, file) === syntax(b, file)) report.counts.commentsOnly++;
  else if (runtime(a, file) === runtime(b, file)) report.typeDifferences.push(file);
  else report.runtimeDifferences.push(file);
}
function jsonDifferences(local, online, location = "") {
  if (typeof local !== typeof online || (local === null) !== (online === null)) return [location];
  if (Array.isArray(local) && Array.isArray(online)) {
    if ([...local, ...online].every((item) => item && typeof item === "object" && "id" in item)) {
      return jsonDifferences(Object.fromEntries(local.map((item) => [item.id, item])), Object.fromEntries(online.map((item) => [item.id, item])), location);
    }
    return JSON.stringify(local) === JSON.stringify(online) ? [] : [location];
  }
  if (local && typeof local === "object" && online && typeof online === "object") {
    return [...new Set([...Object.keys(local), ...Object.keys(online)])].sort().flatMap((key) => {
      const current = `${location}/${key}`;
      return !(key in local) || !(key in online) ? [current] : jsonDifferences(local[key], online[key], current);
    });
  }
  return local === online ? [] : [location];
}
for (const file of ["config.json", "model-catalog.json", "plugin-registry.json", "packages/flowlet-core/package.json"]) {
  const remote = path.join(snapshot, file);
  report.configurationDifferences[file] = existsSync(remote)
    ? jsonDifferences(JSON.parse(source(file)), JSON.parse(readFileSync(remote, "utf8")))
    : ["missing from snapshot"];
}
// Some host modules also consume pure helpers from the CLI package.
const cliSourceFiles = sourceFiles("packages/flowlet-cred/src").filter(isModule);
report.hostSharedCli = { checked: 0, differences: [], missingSource: [] };
for (const file of walk(path.join(snapshot, "packages/flowlet-cred/src")).filter(isModule)) {
  const relative = path.relative(snapshot, file);
  if (!cliSourceFiles.includes(relative)) { report.hostSharedCli.missingSource.push(relative); continue; }
  report.hostSharedCli.checked++;
  if (readFileSync(file, "utf8") !== source(relative)) report.hostSharedCli.differences.push(relative);
}
const cliArchive = path.join(snapshot, "ui/downloads/flowlet-cli.tar.gz");
if (existsSync(cliArchive)) {
  report.cli = { checked: 0, differences: [], missing: [] };
  for (const file of cliSourceFiles) {
    const member = `flowlet-cli/${file.slice("packages/flowlet-cred/".length)}`;
    let body;
    try { body = execFileSync("tar", ["-xOf", cliArchive, member], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); }
    catch { report.cli.missing.push(file); continue; }
    report.cli.checked++;
    if (body !== source(file)) report.cli.differences.push(file);
  }
}
const uiDir = option("--ui-dir");
if (uiDir) {
  report.ui = { checked: 0, missing: [], differences: [] };
  const dir = path.resolve(uiDir);
  if (!existsSync(path.join(dir, "index.html"))) throw new Error("--ui-dir must contain a completed build with index.html");
  for (const file of walk(dir)) {
    const relative = path.relative(dir, file), remote = path.join(snapshot, "ui", relative);
    report.ui.checked++;
    if (!existsSync(remote)) report.ui.missing.push(relative);
    else if (!readFileSync(file).equals(readFileSync(remote))) report.ui.differences.push(relative);
  }
}
const output = JSON.stringify(report, null, 2) + "\n";
const reportPath = option("--report");
if (reportPath) { mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true }); writeFileSync(reportPath, output); }
console.log(output);
if (report.onlineOnly.length || report.unexpectedSourceOnly.length || report.typeDifferences.length || report.runtimeDifferences.length
  || Object.values(report.configurationDifferences).some((items) => items.length)
  || report.hostSharedCli.differences.length || report.hostSharedCli.missingSource.length
  || report.cli?.differences.length || report.cli?.missing.length || report.ui?.differences.length || report.ui?.missing.length) process.exitCode = 2;
