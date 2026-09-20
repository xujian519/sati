/**
 * i18n namespace 一致性门禁。
 *
 * 背景：`ui/src/i18n/config.js` 手写每个语言的资源注册表，语言包文件却按目录存放。
 * 两者不同步时**不报错**——i18next 静默回落到 `fallbackLng: "en"`，表现为「中文界面
 * 某些文案是英文」。真实案例：`locales/zh-CN/tasks.json` 存在但 zh-CN 资源表漏注册
 * 了 `tasks`（`ns` 列表却声明了它）。该命名空间目前无消费者，所以当时没有可见症状——
 * 但只要有人第一次用 `t(k, { ns: "tasks" })`，中文界面就静默变英文；本门禁把这类
 * 「注册表 ↔ 语言包」不一致挡在合入前。
 *
 * 判据（AST 声明侧 vs 文件系统侧，非同源对拍）：
 *   1. 每个含 `.json` 的语言目录都在 `resources` 里注册；
 *   2. 每个语言的注册键集合 == 该语言目录下的 `.json` 文件集合；
 *   3. `ns` 列表的每个命名空间都在每个语言下注册；
 *   4. 各语言的注册键集合彼此相同（跨语言 parity）。
 *
 * 用法：
 *   pnpm check:i18n-namespaces
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { exit } from "node:process";
import { pathToFileURL } from "node:url";
import ts from "typescript";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const DEFAULT_CONFIG_PATH = join(REPO_ROOT, "ui", "src", "i18n", "config.js");
const DEFAULT_LOCALES_DIR = join(REPO_ROOT, "ui", "src", "i18n", "locales");

type JsonObject = ts.ObjectLiteralExpression;

function isObjectLiteral(node: ts.Node): node is JsonObject {
  return ts.isObjectLiteralExpression(node);
}

/** 对象字面量的键名（标识符或字符串字面量），计算属性等非常规形态返回 undefined。 */
function keyName(node: ts.PropertyAssignment): string | undefined {
  const name = node.name;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) {
    return name.text;
  }
  return undefined;
}

function propertyNames(object: JsonObject): string[] {
  const names: string[] = [];
  for (const member of object.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const name = keyName(member);
    if (name !== undefined) names.push(name);
  }
  return names.sort();
}

/** 在 source file 中查找具名属性（顶层 init 调用里的 `resources` / `ns`）。 */
function findProperty(source: ts.SourceFile, name: string): ts.PropertyAssignment | undefined {
  let found: ts.PropertyAssignment | undefined;
  const visit = (node: ts.Node): void => {
    if (found !== undefined) return;
    if (ts.isPropertyAssignment(node) && keyName(node) === name) {
      found = node;
      return;
    }
    node.forEachChild(visit);
  };
  visit(source);
  return found;
}

function registeredPerLanguage(source: ts.SourceFile, configPath: string): Map<string, string[]> {
  const resources = findProperty(source, "resources");
  if (resources === undefined || !isObjectLiteral(resources.initializer)) {
    throw new Error(`${configPath}: 未找到 resources 对象字面量`);
  }
  const result = new Map<string, string[]>();
  for (const member of resources.initializer.properties) {
    if (!ts.isPropertyAssignment(member)) continue;
    const language = keyName(member);
    if (language === undefined) continue;
    if (!isObjectLiteral(member.initializer)) {
      throw new Error(`${configPath}: resources.${language} 不是对象字面量`);
    }
    result.set(language, propertyNames(member.initializer));
  }
  return result;
}

function declaredNamespaces(source: ts.SourceFile, configPath: string): string[] {
  const ns = findProperty(source, "ns");
  if (ns === undefined || !ts.isArrayLiteralExpression(ns.initializer)) {
    throw new Error(`${configPath}: 未找到 ns 数组字面量`);
  }
  return ns.initializer.elements
    .filter(ts.isStringLiteral)
    .map(element => element.text)
    .sort();
}

function localeNamespaces(localesDir: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const entry of readdirSync(localesDir)) {
    const dir = join(localesDir, entry);
    if (!statSync(dir).isDirectory()) continue;
    const namespaces = readdirSync(dir)
      .filter(file => file.endsWith(".json"))
      .map(file => file.replace(/\.json$/, ""));
    if (namespaces.length > 0) result.set(entry, namespaces.sort());
  }
  return result;
}

function diff(expected: string[], actual: string[]): { missing: string[]; extra: string[] } {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter(item => !actualSet.has(item)),
    extra: actual.filter(item => !expectedSet.has(item)),
  };
}

export type I18nNamespaceAudit = {
  issues: string[];
  languages: string[];
  namespaceCount: number;
};

/** 纯函数核心：给定 config.js 与 locales 目录，返回不一致清单（空数组 = 一致）。 */
export function auditI18nNamespaces(options: { configPath?: string; localesDir?: string } = {}): I18nNamespaceAudit {
  const configPath = options.configPath ?? DEFAULT_CONFIG_PATH;
  const localesDir = options.localesDir ?? DEFAULT_LOCALES_DIR;
  const source = ts.createSourceFile(
    configPath,
    readFileSync(configPath, "utf8"),
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.JS,
  );

  const registered = registeredPerLanguage(source, configPath);
  const ns = declaredNamespaces(source, configPath);
  const onDisk = localeNamespaces(localesDir);
  const issues: string[] = [];

  for (const [language, namespaces] of onDisk) {
    const wired = registered.get(language);
    if (wired === undefined) {
      issues.push(`语言目录 locales/${language}/ 未在 resources 中注册`);
      continue;
    }
    const { missing, extra } = diff(namespaces, wired);
    if (missing.length > 0) {
      issues.push(`locales/${language}/: 语言包存在但未注册 → ${missing.join(", ")}`);
    }
    if (extra.length > 0) {
      issues.push(`locales/${language}/: 已注册但语言包缺失 → ${extra.join(", ")}`);
    }
  }
  for (const [language] of registered) {
    if (!onDisk.has(language)) issues.push(`resources.${language}: 无对应 locales/${language}/ 目录`);
  }

  for (const [language, wired] of registered) {
    const { missing } = diff(ns, wired);
    if (missing.length > 0) issues.push(`resources.${language}: ns 已声明但未注册 → ${missing.join(", ")}`);
  }

  const languages = [...registered.keys()].sort();
  const reference = languages[0];
  if (reference !== undefined) {
    for (const language of languages.slice(1)) {
      const { missing, extra } = diff(registered.get(reference) ?? [], registered.get(language) ?? []);
      if (missing.length > 0 || extra.length > 0) {
        issues.push(
          `跨语言 parity 不一致（${reference} vs ${language}）: 缺 [${missing.join(", ")}] 多 [${extra.join(", ")}]`,
        );
      }
    }
  }

  return { issues, languages, namespaceCount: registered.get(reference ?? "")?.length ?? 0 };
}

function main(): void {
  const audit = auditI18nNamespaces();
  if (audit.issues.length > 0) {
    console.error(`check-i18n-namespaces: ${audit.issues.length} 处不一致`);
    for (const issue of audit.issues) console.error(`  - ${issue}`);
    exit(1);
  }
  console.log(`check-i18n-namespaces: fresh（${audit.languages.length} 语言，${audit.namespaceCount} namespace）`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
