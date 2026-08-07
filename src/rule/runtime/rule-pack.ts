/**
 * 宪法规则引擎 — 分层规则包（Rule Pack）装配器。
 *
 * 三层合并式加载：base（全领域通用）→ domains（清单声明顺序）→ overrides（项目私有）。
 * 复用 RuleLoader 的 loadRuleSetDir / mergeRuleSets（后加载按 id 覆盖）。
 *
 * 项目清单：WorkSpace 根的 `.sati/rules.yaml`（全新约定，见 rules/README.md）：
 *   base: base                # 内置包名；或绝对路径（外部包 v1 用路径引用）
 *   domains: [mechanical]     # 可多个
 *   overrides: ./local-rules/ # 可选，相对清单所在目录
 *
 * 无清单时回退默认行为：仅加载 rules/base（零配置可用）。
 * 坏包不阻塞：单层加载失败记 warning 继续。
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseDocument } from "yaml";
import type { RuleSet } from "../protocol/types.js";
import { candidatePackDirs, findWorkspaceRoot } from "./asset-location.js";
import { loadRuleSetDir, mergeRuleSets } from "./RuleLoader.js";

const MANIFEST_FILE = join(".sati", "rules.yaml");
const PACK_MANIFEST_FILE = "pack.yaml";

/** 项目侧规则包清单（`.sati/rules.yaml`）。 */
export type RulePackManifest = {
  /** 内置包名（如 "base"）或绝对路径（外部包）。 */
  base: string;
  /** domain 包名列表（按声明顺序加载）。 */
  domains: string[];
  /** 项目私有规则目录（相对清单所在目录或绝对路径）。 */
  overrides?: string;
};

/** 分层规则包加载结果。 */
export type RulePackLoadResult = {
  ruleSet: RuleSet;
  sources: string[];
  warnings: string[];
  /** 每条规则来自哪层（ruleId → 层名），供诊断/审计。 */
  layers: Map<string, string>;
  /** 实际使用的清单路径；无清单时为 null。 */
  manifestPath: string | null;
  /** 清单文件 mtime（毫秒）；无清单时为 null。供调用方做缓存失效判断。 */
  manifestMtimeMs: number | null;
};

/** 包清单（pack.yaml）校验问题。 */
export type PackManifestIssue = { field: string; message: string };

/** 定位项目清单：显式路径 > cwd/.sati/rules.yaml > WorkSpace 根。未找到返回 null。 */
export function resolveRulePackManifestPath(explicitPath?: string): string | null {
  if (explicitPath) {
    const p = resolve(explicitPath);
    return existsSync(p) ? p : null;
  }
  const fromCwd = resolve(process.cwd(), MANIFEST_FILE);
  if (existsSync(fromCwd)) return fromCwd;
  const fromRoot = resolve(findWorkspaceRoot(), MANIFEST_FILE);
  return existsSync(fromRoot) ? fromRoot : null;
}

/** 解析项目清单；结构非法抛错（由调用方记 warning 降级）。 */
export function parseRulePackManifest(yamlText: string): RulePackManifest {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    throw new Error(`清单 YAML 解析失败: ${doc.errors[0]?.message ?? "unknown"}`);
  }
  const root = doc.toJS();
  if (typeof root !== "object" || root === null || Array.isArray(root)) {
    throw new Error("清单顶层必须是对象");
  }
  const record = root as Record<string, unknown>;
  const base = typeof record.base === "string" && record.base.trim() !== "" ? record.base.trim() : null;
  if (base === null) throw new Error("清单缺少 base 字段（内置包名或绝对路径）");
  let domains: string[] = [];
  if (record.domains !== undefined) {
    if (!Array.isArray(record.domains) || record.domains.some(d => typeof d !== "string")) {
      throw new Error("清单 domains 必须是字符串数组");
    }
    domains = record.domains as string[];
  }
  const overrides =
    typeof record.overrides === "string" && record.overrides.trim() !== "" ? record.overrides.trim() : undefined;
  return { base, domains, overrides };
}

/**
 * 校验包清单（pack.yaml）；与 rules/pack.schema.json 保持同步。
 * 返回问题列表（空 = 通过）。
 */
export function validatePackManifest(raw: unknown, opts: { requireDomain?: boolean } = {}): PackManifestIssue[] {
  const issues: PackManifestIssue[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    issues.push({ field: "(root)", message: "pack.yaml 顶层必须是对象" });
    return issues;
  }
  const record = raw as Record<string, unknown>;
  const knownFields = new Set(["id", "version", "description", "domain"]);
  for (const key of Object.keys(record)) {
    if (!knownFields.has(key)) issues.push({ field: key, message: `未知字段 "${key}"` });
  }
  if (typeof record.id !== "string" || !/^sati-rules-[a-z0-9-]+$/.test(record.id)) {
    issues.push({ field: "id", message: "id 必填且须形如 sati-rules-<slug>" });
  }
  if (typeof record.version !== "string" || !/^\d+\.\d+\.\d+$/.test(record.version)) {
    issues.push({ field: "version", message: "version 必填且须为 semver（x.y.z）" });
  }
  if (typeof record.description !== "string" || record.description.trim() === "") {
    issues.push({ field: "description", message: "description 必填且非空" });
  }
  if (record.domain !== undefined && (typeof record.domain !== "string" || record.domain.trim() === "")) {
    issues.push({ field: "domain", message: "domain 若非空须为字符串" });
  }
  if (opts.requireDomain === true && (typeof record.domain !== "string" || record.domain.trim() === "")) {
    issues.push({ field: "domain", message: "领域包清单必须声明 domain" });
  }
  return issues;
}

/** 定位内置包目录；未找到返回 null。绝对路径引用直接返回（若存在）。 */
export function resolvePackDir(nameOrPath: string): string | null {
  if (isAbsolute(nameOrPath)) {
    return existsSync(nameOrPath) ? nameOrPath : null;
  }
  for (const dir of candidatePackDirs(nameOrPath)) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** 校验包目录内的 pack.yaml；问题记 warning（不阻塞规则加载）。 */
function checkPackManifest(dir: string, layerName: string, warnings: string[]): void {
  const manifestPath = join(dir, PACK_MANIFEST_FILE);
  if (!existsSync(manifestPath)) {
    warnings.push(`规则包 ${layerName} 缺少 pack.yaml 清单（${manifestPath}）`);
    return;
  }
  try {
    const doc = parseDocument(readFileSync(manifestPath, "utf8"));
    if (doc.errors.length > 0) {
      warnings.push(`规则包 ${layerName} 清单解析失败: ${doc.errors[0]?.message ?? "unknown"}`);
      return;
    }
    // 领域包须声明 domain（按层语义判断，而非目录路径）
    const isDomainPack = layerName.startsWith("domain:");
    const issues = validatePackManifest(doc.toJS(), { requireDomain: isDomainPack });
    for (const issue of issues) {
      warnings.push(`规则包 ${layerName} 清单非法（${issue.field}）: ${issue.message}`);
    }
  } catch (error) {
    warnings.push(`规则包 ${layerName} 清单读取失败: ${(error as Error).message}`);
  }
}

/**
 * 加载分层规则包。
 *
 * @param options.manifestPath 显式清单路径（测试注入用）；缺省按约定查找。
 */
export function loadRulePack(options: { manifestPath?: string } = {}): RulePackLoadResult {
  const warnings: string[] = [];
  const sources: string[] = [];
  const layers = new Map<string, string>();
  const layerOrder: Array<{ name: string; ruleSet: RuleSet }> = [];

  const manifestPath = resolveRulePackManifestPath(options.manifestPath);
  let manifest: RulePackManifest = { base: "base", domains: [] };
  let manifestMtimeMs: number | null = null;
  if (manifestPath !== null) {
    try {
      manifest = parseRulePackManifest(readFileSync(manifestPath, "utf8"));
      manifestMtimeMs = statSync(manifestPath).mtimeMs;
    } catch (error) {
      warnings.push(`规则包清单加载失败（${manifestPath}）: ${(error as Error).message}；回退仅加载 rules/base`);
    }
  }

  const manifestDir = manifestPath !== null ? dirname(manifestPath) : process.cwd();

  const loadLayer = (layerName: string, dirOrPath: string, refType: "builtin" | "path"): void => {
    const dir = refType === "builtin" ? resolvePackDir(dirOrPath) : resolve(manifestDir, dirOrPath);
    if (dir === null) {
      warnings.push(`规则包 ${layerName} 未找到（引用: ${dirOrPath}），跳过`);
      return;
    }
    if (existsSync(join(dir, PACK_MANIFEST_FILE))) {
      checkPackManifest(dir, layerName, warnings);
    } else if (layerName !== "overrides") {
      warnings.push(`规则包 ${layerName} 缺少 pack.yaml 清单（${dir}）`);
    }
    const { ruleSets, sources: layerSources, warnings: layerWarnings } = loadRuleSetDir(dir);
    warnings.push(...layerWarnings.map(w => w.message));
    if (layerSources.length === 0 && layerName !== "overrides") {
      warnings.push(`规则包 ${layerName} 无可加载规则文件（${dir}）`);
    }
    sources.push(...layerSources);
    layerOrder.push({ name: layerName, ruleSet: mergeRuleSets(ruleSets) });
  };

  loadLayer("base", manifest.base, isAbsolute(manifest.base) ? "path" : "builtin");
  for (const domain of manifest.domains) {
    loadLayer(`domain:${domain}`, domain, isAbsolute(domain) ? "path" : "builtin");
  }
  if (manifest.overrides !== undefined) {
    loadLayer("overrides", manifest.overrides, "path");
  }

  // 逐层合并并记录来源；domain/overrides 覆盖 base 规则时记审计 warning。
  const merged: RuleSet[] = [];
  for (const layer of layerOrder) {
    for (const rule of layer.ruleSet.rules) {
      const previous = layers.get(rule.id);
      if (previous !== undefined) {
        warnings.push(`规则 ${rule.id} 被 ${layer.name} 层覆盖（原: ${previous}）`);
      }
      layers.set(rule.id, layer.name);
    }
    merged.push(layer.ruleSet);
  }

  return {
    ruleSet: mergeRuleSets(merged),
    sources,
    warnings,
    layers,
    manifestPath,
    manifestMtimeMs,
  };
}

/** layers 摘要（如 "base 8 + domain:mechanical 1 + overrides 1"），供工具输出。 */
export function summarizeRulePackLayers(layers: Map<string, string>): string {
  const counts = new Map<string, number>();
  for (const layer of layers.values()) {
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  return [...counts.entries()].map(([layer, count]) => `${layer} ${count}`).join(" + ");
}
