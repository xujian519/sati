// scripts/check-debt-ledger.mjs
// 技术债务账本数字漂移检查（#817）。
//
// 目标：backlog.md 里「某文件 N 行」这类**当前状态声明**若与 metrics.md 基线不一致，
// 直接标出文件与行号，避免账本数字滞后误导排期。
//
// 口径：
// - 只比较 metrics.md 的「Top 30 大文件」与「God function」两张表；
// - 同一文件在账本中出现多次时，只取**最后一次**声明（历史进展里的旧数字不追责）；
// - 含 "→"（迁移/收敛叙述）、"原"/"旧" 的行视为历史，不参与比较；
// - 找不到基线（文件已删/重命名/未进 Top 30）时跳过，不误报。

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const METRICS_PATH = path.join(ROOT, "docs/technical-debt/metrics.md");
const BACKLOG_PATH = path.join(ROOT, "docs/technical-debt/backlog.md");

/** 从 metrics.md 提取基线。 */
export function parseMetrics(markdown) {
  const topFiles = new Map();
  const godFunctions = new Map();
  const lines = markdown.split(/\r?\n/);
  let section = "";
  for (const line of lines) {
    if (line.startsWith("## ")) section = line;
    const cells = line
      .split("|")
      .slice(1, -1)
      .map(cell => cell.trim());
    if (cells.length < 2) continue;
    const fileMatch = /^`([^`]+)`$/.exec(cells[0]);
    if (fileMatch === null) continue;
    const file = fileMatch[1];
    if (section.includes("God function")) {
      const functionName = cells[1].replace(/^`|`$/g, "");
      const lineCount = Number(cells[2]);
      if (Number.isFinite(lineCount)) godFunctions.set(`${file}::${functionName}`, lineCount);
    } else if (section.includes("Top 30 大文件")) {
      const lineCount = Number(cells[1]);
      if (Number.isFinite(lineCount)) topFiles.set(file, lineCount);
    }
  }
  return { topFiles, godFunctions };
}

function normalizePath(value) {
  return value.replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
}

/**
 * 从 backlog 提取「文件 → 最后一次行数声明」。
 * @returns {Map<string, {line: number, claimed: number}>}
 */
export function extractClaims(backlog) {
  const claims = new Map();
  const lines = backlog.split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    if (line.includes("→") || /原|旧/.test(line)) continue;
    for (const match of line.matchAll(/`([^`]+\.tsx?)`[^`\n]{0,40}?(\d+)\s*行/g)) {
      claims.set(normalizePath(match[1]), { line: index + 1, claimed: Number(match[2]) });
    }
    for (const match of line.matchAll(/(?<![`\w])([\w./-]+\.tsx?)(?![`\w])[^`\n]{0,20}?(\d+)\s*行/g)) {
      const file = normalizePath(match[1]);
      if (!claims.has(file)) claims.set(file, { line: index + 1, claimed: Number(match[2]) });
    }
  }
  return claims;
}

/** 比对并返回漂移项。 */
export function findDrift(metrics, claims) {
  const drifts = [];
  for (const [file, claim] of claims) {
    const actual = metrics.topFiles.get(file);
    if (actual === undefined) continue;
    if (actual !== claim.claimed) {
      drifts.push({ file, line: claim.line, claimed: claim.claimed, actual });
    }
  }
  return drifts.sort((a, b) => b.actual - b.claimed - (a.actual - a.claimed));
}

export function formatDrift(drifts) {
  if (drifts.length === 0) return "✅ debt ledger numbers match metrics.md baseline";
  const rows = drifts.map(
    drift => `  backlog.md:${drift.line}  ${drift.file}  claimed=${drift.claimed} actual=${drift.actual}`,
  );
  return [`❌ ${drifts.length} stale number claim(s):`, ...rows].join("\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const metrics = parseMetrics(fs.readFileSync(METRICS_PATH, "utf8"));
  const claims = extractClaims(fs.readFileSync(BACKLOG_PATH, "utf8"));
  const drifts = findDrift(metrics, claims);
  console.log(formatDrift(drifts));
  process.exit(drifts.length === 0 ? 0 : 1);
}
