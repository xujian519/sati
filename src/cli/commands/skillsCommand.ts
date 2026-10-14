/**
 * `sati skills migrate` — 从其它 agent（Claude Code / OpenClaw / Hermes）迁移 skills
 * （P2.7 从 `cli/sati.ts` 原样搬出，逐 token 未改）。
 *
 * 默认 dry-run，须显式 `--execute` 才落盘；冲突策略 skip/overwrite/rename 三态。
 * `--json` 输出完整报告供脚本消费，人读形态经 `printSkillMigrationReport`。
 * 有 error 项时退出码 1（dry-run 下不设退出码）。
 */

import {
  migrateSkillsToSati,
  type SkillMigrationConflictMode,
  type SkillMigrationItem,
  type SkillMigrationReport,
  type SkillMigrationSourceKind,
} from "../../extension/skills/index.js";
import { resolvePilotHome } from "../../pilot/index.js";
import { plainLogger as out } from "../../telemetry/index.js";
import { readRepeatedStringFlag, readStringFlag } from "./flagParsing.js";

export async function runSkillsCommand(argv: string[]): Promise<void> {
  const command = argv[0];
  if (command !== "migrate") {
    out.error(
      "Usage: sati skills migrate [--execute] [--from cc,openclaw,hermes] [--source <dir>] [--overwrite|--rename]",
    );
    process.exitCode = 1;
    return;
  }

  const from = parseSkillMigrationSources(readStringFlag(argv, "--from"));
  const conflictMode: SkillMigrationConflictMode = argv.includes("--overwrite")
    ? "overwrite"
    : argv.includes("--rename")
      ? "rename"
      : "skip";
  const projectRoot = readStringFlag(argv, "--project") ?? process.cwd();
  const pilotHome = readStringFlag(argv, "--pilot-home") ?? resolvePilotHome(process.env);
  const report = await migrateSkillsToSati({
    pilotHome,
    projectRoot,
    include: from,
    customSources: readRepeatedStringFlag(argv, "--source"),
    execute: argv.includes("--execute"),
    conflictMode,
  });

  if (argv.includes("--json")) {
    out.info(JSON.stringify(report, null, 2));
    return;
  }

  printSkillMigrationReport(report);
  if (report.summary.error > 0) {
    process.exitCode = 1;
  }
}

export function parseSkillMigrationSources(
  value: string | undefined,
): Array<Exclude<SkillMigrationSourceKind, "custom">> | undefined {
  if (!value) return undefined;
  const sources: Array<Exclude<SkillMigrationSourceKind, "custom">> = [];
  for (const raw of value.split(",")) {
    const normalized = raw.trim().toLowerCase();
    if (!normalized) continue;
    if (normalized === "cc" || normalized === "claude" || normalized === "claude-code") {
      sources.push("claude-code");
    } else if (normalized === "openclaw") {
      sources.push("openclaw");
    } else if (normalized === "hermes") {
      sources.push("hermes");
    } else if (normalized === "all") {
      sources.push("claude-code", "openclaw", "hermes");
    } else {
      throw new Error(`Unknown skills source "${raw}". Use cc, openclaw, hermes, or all.`);
    }
  }
  return sources.length > 0 ? [...new Set(sources)] : undefined;
}

export function printSkillMigrationReport(report: SkillMigrationReport): void {
  const mode = report.mode === "execute" ? "EXECUTED" : "DRY RUN";
  out.info(`Sati skills migration (${mode})`);
  out.info(`Target: ${report.targetRoot}`);
  out.info(
    `Summary: migrated=${report.summary.migrated} would_migrate=${report.summary.would_migrate} ` +
      `conflict=${report.summary.conflict} skipped=${report.summary.skipped} error=${report.summary.error}`,
  );

  const actionable = report.items.filter(item => item.status !== "skipped");
  if (actionable.length > 0) {
    out.info("");
    for (const item of actionable) {
      out.info(`${formatSkillMigrationStatus(item)} ${item.sourceLabel}: ${item.slug || "(n/a)"}`);
      out.info(`  ${item.sourcePath}`);
      if (item.destinationPath) out.info(`  -> ${item.destinationPath}`);
      if (item.reason) out.info(`  ${item.reason}`);
    }
  }

  if (report.mode === "dry-run") {
    out.info("");
    out.info("This was a dry run. Add --execute to copy skills.");
  }
}

export function formatSkillMigrationStatus(item: SkillMigrationItem): string {
  if (item.status === "migrated") return "+";
  if (item.status === "would_migrate") return "?";
  if (item.status === "conflict") return "!";
  if (item.status === "error") return "x";
  return "-";
}
