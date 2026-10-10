#!/usr/bin/env node
// check-degradation-registry.mjs
// fail-open / fail-closed 降级语义 registry 门禁（挂 pnpm lint）。
//
// 唯一事实源：assets/degradation/registry.yaml —— 每条 = 一个外部/软依赖的降级行为单元，
// 五要素（component / dependency / failDirection / degradedBehavior / degradedImpact）
// + observability（可观测足迹，铁律 11 的机器化）+ negativeDrill（负向演练）。
// 立规背景与任务拆分见 docs/degradation-registry-plan.md；对账基线见
// docs/degradation-baseline-inventory.md。schema 文件仅作文档/编辑器用途——仓库无
// JSON Schema 校验器，硬校验在本脚本（手写校验先例：src/rule/runtime/rule-pack.ts）。
//
// 本脚本强制的规则：
//   1. 结构：顶层 entries 数组；id 唯一且 kebab-case。
//   2. component / negativeDrill 指向的文件必须存在——路径失效即红（防登记腐烂）。
//   3. failDirection ∈ {open, closed, mixed}。
//   4. observability 不得为空——除非带 waiver（kind: intentional_silence + reason）。
//      「降级但不静默」没有可观测足迹就必须书面豁免，豁免必须写清理由。
//   5. negativeDrill 可缺省，但必须带 waiver（kind: drill_missing + reason）。
//   6. 冗余豁免即红：drill 已存在不得再挂 drill_missing；observability 已填不得再挂
//      intentional_silence——豁免是「暂时没有」的书面承认，不是永久标签。
//
// 用法：
//   node scripts/check-degradation-registry.mjs            # 门禁（默认）
//   node scripts/check-degradation-registry.mjs --stats    # 条目数与 failDirection 分布（供对账）
//   node scripts/check-degradation-registry.mjs --root DIR # 供负控制测试指向 fixture 树

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const LABEL = "check-degradation-registry";
const REGISTRY_RELATIVE_PATH = "assets/degradation/registry.yaml";
const FAIL_DIRECTIONS = new Set(["open", "closed", "mixed"]);
const WAIVER_KINDS = new Set(["drill_missing", "intentional_silence"]);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const USAGE = `用法：node scripts/check-degradation-registry.mjs [--stats] [--root DIR]
  --stats     打印条目数与 failDirection 分布（仍执行全部校验）
  --root DIR  仓库根（默认由脚本位置推导；负控制测试用）`;

function parseArgs(argv, defaultRoot) {
  let root = defaultRoot;
  let stats = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--root") {
      const value = argv[i + 1];
      if (value === undefined) return { error: "--root 需要一个目录参数" };
      root = resolve(value);
      i += 1;
    } else if (arg === "--stats") {
      stats = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true };
    } else {
      return { error: `无法识别的参数 ${JSON.stringify(arg)}` };
    }
  }
  return { root, stats };
}

const isNonEmptyString = value => typeof value === "string" && value.trim().length > 0;

/** 把 waiver 字段规范化为数组（允许单个对象或对象数组两种写法）。 */
function normalizeWaivers(entry) {
  const { waiver } = entry;
  if (waiver === undefined) return [];
  return Array.isArray(waiver) ? waiver : [waiver];
}

/** 校验单条 entry，问题以人类可读文本追加进 problems。 */
function validateEntry(root, entry, index, seenIds, problems) {
  const fallbackLabel = `第 ${index + 1} 条`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    problems.push(`[${fallbackLabel}] 不是对象`);
    return;
  }
  const where = isNonEmptyString(entry.id) ? `[${entry.id}]` : `[${fallbackLabel}]`;

  if (!isNonEmptyString(entry.id)) {
    problems.push(`${where} id 缺失或不是字符串`);
  } else if (!ID_PATTERN.test(entry.id)) {
    problems.push(`${where} id 须为 kebab-case（^[a-z0-9][a-z0-9-]*$）`);
  } else if (seenIds.has(entry.id)) {
    problems.push(`${where} id 重复`);
  } else {
    seenIds.add(entry.id);
  }

  if (!isNonEmptyString(entry.component)) {
    problems.push(`${where} component 缺失`);
  } else if (!existsSync(join(root, entry.component))) {
    problems.push(`${where} component 路径不存在：${entry.component}（登记已腐烂，修正或删除条目）`);
  }

  for (const field of ["dependency", "degradedBehavior", "degradedImpact"]) {
    if (!isNonEmptyString(entry[field])) problems.push(`${where} ${field} 缺失或为空`);
  }

  if (!FAIL_DIRECTIONS.has(entry.failDirection)) {
    problems.push(`${where} failDirection 必须是 open / closed / mixed（收到 ${JSON.stringify(entry.failDirection)}）`);
  }

  // 豁免：先校验自身合法性，再用于豁免判定与冗余检测。
  const waivers = normalizeWaivers(entry);
  const waiverKinds = new Set();
  for (const waiver of waivers) {
    if (waiver === null || typeof waiver !== "object" || Array.isArray(waiver)) {
      problems.push(`${where} waiver 不是对象`);
      continue;
    }
    if (!WAIVER_KINDS.has(waiver.kind)) {
      problems.push(
        `${where} waiver.kind 必须是 drill_missing / intentional_silence（收到 ${JSON.stringify(waiver.kind)}）`,
      );
      continue;
    }
    if (!isNonEmptyString(waiver.reason)) {
      problems.push(`${where} waiver(${waiver.kind}) 缺 reason——豁免必须写清理由`);
      continue;
    }
    if (waiverKinds.has(waiver.kind)) problems.push(`${where} waiver(${waiver.kind}) 重复`);
    waiverKinds.add(waiver.kind);
  }

  const hasObservability = isNonEmptyString(entry.observability);
  if (!hasObservability && !waiverKinds.has("intentional_silence")) {
    problems.push(`${where} observability 为空：补可观测足迹（日志/诊断/事件/错误码）或挂 waiver(intentional_silence)`);
  }
  if (hasObservability && waiverKinds.has("intentional_silence")) {
    problems.push(`${where} 冗余豁免：observability 已填，请移除 intentional_silence waiver`);
  }

  const hasDrillField = isNonEmptyString(entry.negativeDrill);
  if (!hasDrillField) {
    if (!waiverKinds.has("drill_missing")) {
      problems.push(`${where} negativeDrill 缺失：补负向演练测试或挂 waiver(drill_missing)`);
    }
  } else if (!existsSync(join(root, entry.negativeDrill))) {
    problems.push(`${where} negativeDrill 路径不存在：${entry.negativeDrill}（登记已腐烂，修正或删除条目）`);
  } else if (waiverKinds.has("drill_missing")) {
    problems.push(`${where} 冗余豁免：negativeDrill 已存在，请移除 drill_missing waiver`);
  }
}

function countByDirection(entries) {
  const counts = { open: 0, closed: 0, mixed: 0, unknown: 0 };
  let waived = 0;
  for (const entry of entries) {
    if (entry !== null && typeof entry === "object" && FAIL_DIRECTIONS.has(entry.failDirection)) {
      counts[entry.failDirection] += 1;
    } else {
      counts.unknown += 1;
    }
    if (entry !== null && typeof entry === "object" && entry.waiver !== undefined) waived += 1;
  }
  return { counts, waived };
}

function main() {
  const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const parsed = parseArgs(process.argv.slice(2), defaultRoot);
  if (parsed.help) {
    console.log(USAGE);
    return 0;
  }
  if (parsed.error) {
    console.error(`${LABEL}: ${parsed.error}`);
    console.error(USAGE);
    return 2;
  }
  const { root, stats } = parsed;

  const registryPath = join(root, REGISTRY_RELATIVE_PATH);
  if (!existsSync(registryPath)) {
    console.error(`${LABEL}: ${REGISTRY_RELATIVE_PATH} 不存在（registry 缺失即门禁失效）`);
    return 1;
  }

  let parsedRegistry;
  try {
    parsedRegistry = parseYaml(readFileSync(registryPath, "utf8"));
  } catch (error) {
    console.error(`${LABEL}: ${REGISTRY_RELATIVE_PATH} YAML 解析失败：${error.message}`);
    return 1;
  }
  if (parsedRegistry === null || typeof parsedRegistry !== "object" || Array.isArray(parsedRegistry)) {
    console.error(`${LABEL}: ${REGISTRY_RELATIVE_PATH} 顶层必须是对象`);
    return 1;
  }
  if (!Array.isArray(parsedRegistry.entries)) {
    console.error(`${LABEL}: ${REGISTRY_RELATIVE_PATH} 缺少 entries 数组`);
    return 1;
  }

  const { entries } = parsedRegistry;
  const problems = [];
  const seenIds = new Set();
  entries.forEach((entry, index) => validateEntry(root, entry, index, seenIds, problems));

  const { counts, waived } = countByDirection(entries);
  const distribution = `open ${counts.open} / closed ${counts.closed} / mixed ${counts.mixed}${
    counts.unknown > 0 ? ` / 非法 ${counts.unknown}` : ""
  }`;

  if (problems.length > 0) {
    console.error(`${LABEL}: 发现 ${problems.length} 处 registry 违规（${entries.length} 条目）：`);
    for (const problem of problems) console.error(`  ✗ ${problem}`);
    console.error(`  → 立规与豁免口径见 docs/degradation-registry-plan.md（T2 对账基线见 baseline-inventory）`);
    return 1;
  }

  if (stats) {
    console.log(`${LABEL}: 条目总数 ${entries.length}`);
    console.log(`${LABEL}: failDirection 分布 ${distribution}`);
    console.log(`${LABEL}: 带豁免条目 ${waived}`);
  } else {
    console.log(`${LABEL}: fresh（${entries.length} 条目；${distribution}；豁免 ${waived}）`);
  }
  return 0;
}

process.exitCode = main();
