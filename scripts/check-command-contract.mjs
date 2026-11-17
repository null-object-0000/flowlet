#!/usr/bin/env node
// Node 命令名称注册契约（静态检查，不启动 Host、不调用外部服务）。
// 检查前端字面量命令 → Node Web dispatch / desktop registry，以及 Web 授权白名单。
// 不验证参数、返回结构、实际行为或测试覆盖率；行为验证仍需 Node tests / node:e2e。
// 用法：npm run node:commands [-- --json]
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issues = [];
const unresolved = [];

function source(relativePath) {
  return ts.createSourceFile(relativePath, readFileSync(path.join(ROOT, relativePath), "utf8"), ts.ScriptTarget.Latest, true);
}
function walk(node, visit) {
  visit(node);
  ts.forEachChild(node, child => walk(child, visit));
}
function variable(file, name) {
  let result;
  walk(file, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name) result = node.initializer;
  });
  if (!result) throw new Error(`${file.fileName}: 找不到 ${name}，请更新名称契约检查器`);
  return result;
}
function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteral(node)) ? node.text : null;
}
function objectKeys(file, node) {
  if (!ts.isObjectLiteralExpression(node)) throw new Error(`${file.fileName}: 预期显式对象注册表`);
  const keys = [];
  for (const property of node.properties) {
    const key = propertyName(property.name);
    if (!key) throw new Error(`${file.fileName}: 不支持动态/展开注册，请更新检查器`);
    if (keys.includes(key)) issues.push(`${file.fileName}: 重复命令 ${key}`);
    keys.push(key);
  }
  return keys;
}
function commandCases(file) {
  const names = [];
  walk(file, node => {
    if (!ts.isSwitchStatement(node) || !ts.isIdentifier(node.expression) || node.expression.text !== "command") return;
    for (const clause of node.caseBlock.clauses) {
      if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) names.push(clause.expression.text);
    }
  });
  if (!names.length) throw new Error(`${file.fileName}: 未发现 switch(command) 注册`);
  return new Set(names);
}

const web = commandCases(source("packages/flowlet-core/src/web/commands.ts"));
const permissionsFile = source("packages/flowlet-core/src/web/permissions.ts");
const permissionsCall = variable(permissionsFile, "COMMAND_PERMISSIONS");
if (!ts.isCallExpression(permissionsCall)) throw new Error("COMMAND_PERMISSIONS 必须是显式 Object.freeze 对象");
const permissions = new Set(objectKeys(permissionsFile, permissionsCall.arguments[0]));
for (const name of web) if (!permissions.has(name)) issues.push(`Web 命令缺少显式权限声明：${name}`);
for (const name of permissions) if (!web.has(name)) issues.push(`Web 权限声明没有 dispatch：${name}`);

const registryFile = source("packages/flowlet-core/src/desktop/commands.ts");
const registry = variable(registryFile, "REGISTRY");
if (!ts.isObjectLiteralExpression(registry)) throw new Error("desktop REGISTRY 必须是显式对象");
const desktop = new Set();
const imports = new Map();
for (const node of registryFile.statements) {
  if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
  const bindings = node.importClause?.namedBindings;
  if (!bindings || !ts.isNamedImports(bindings)) continue;
  for (const item of bindings.elements) {
    if (item.propertyName?.text === "handlers") imports.set(item.name.text, node.moduleSpecifier.text);
  }
}
for (const entry of registry.properties) {
  if (!ts.isSpreadAssignment(entry) || !ts.isIdentifier(entry.expression) || !imports.has(entry.expression.text)) {
    throw new Error("desktop REGISTRY 注册形式变化，请更新名称契约检查器");
  }
  const modulePath = path.posix.join("packages/flowlet-core/src/desktop", imports.get(entry.expression.text));
  const file = source(modulePath);
  for (const name of objectKeys(file, variable(file, "handlers"))) {
    if (desktop.has(name)) issues.push(`desktop 命令重复注册：${name}`);
    desktop.add(name);
  }
}

function productionFiles(directory) {
  return readdirSync(path.join(ROOT, directory), { withFileTypes: true }).flatMap(entry => {
    const relativePath = path.posix.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" ? [] : productionFiles(relativePath);
    return /\.tsx?$/.test(entry.name) && !/\.(test|spec|d)\.tsx?$/.test(entry.name) ? [relativePath] : [];
  });
}
function literalNames(node) {
  if (node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))) return [node.text];
  if (node && ts.isConditionalExpression(node)) {
    const yes = literalNames(node.whenTrue), no = literalNames(node.whenFalse);
    if (yes && no) return [...yes, ...no];
  }
  return null;
}
const frontend = new Set();
let frontendCallSites = 0;
for (const relativePath of productionFiles("src")) {
  const file = source(relativePath);
  // A2A 的领域 helper `call` 只透传 invokeCommand。平台层的 command 参数本来就是动态的。
  const callees = new Set(["invokeCommand", "invokeWebCommand"]);
  if (relativePath === "src/domains/a2a/commands.ts") callees.add("call");
  walk(file, node => {
    if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression) || !callees.has(node.expression.text)) return;
    const names = literalNames(node.arguments[0]);
    if (!names) {
      unresolved.push(`${relativePath}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1}`);
      return;
    }
    frontendCallSites += 1;
    for (const name of names) {
      frontend.add(name);
      if (!web.has(name) && !desktop.has(name)) issues.push(`${relativePath}: Node 未注册前端命令 ${name}`);
      if (node.expression.text === "invokeWebCommand" && !web.has(name)) issues.push(`${relativePath}: Web 调用使用非白名单命令 ${name}`);
    }
  });
}
if (!frontend.size || !desktop.size) issues.push("没有发现前端/桌面命令，检查器可能已失效");
const report = {
  kind: "node-command-name-contract",
  scope: "静态名称/注册/权限一致性；不验证参数、返回值或行为覆盖率",
  webCommands: web.size,
  desktopCommands: desktop.size,
  frontendCommands: frontend.size,
  frontendCallSites,
  dynamicCallSitesNotValidated: unresolved,
  issues: [...new Set(issues)].sort(),
};
if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
else {
  console.log(`Node 命令名称契约：Web ${web.size} / desktop ${desktop.size} / 前端 ${frontend.size}`);
  console.log(report.scope);
  console.log(`动态透传调用未静态验证：${unresolved.length} 处${unresolved.length ? `（${unresolved.join(", ")}）` : ""}`);
  for (const issue of report.issues) console.error(`  - ${issue}`);
  console.log(report.issues.length ? `发现 ${report.issues.length} 个注册问题` : "名称注册检查通过（非行为覆盖证明）");
}
if (report.issues.length) process.exitCode = 1;
