#!/usr/bin/env tsx
/**
 * 回收孤儿 tool-results 目录（spill 溢出存储的磁盘治理）。
 *
 * spill 的原文文件（`.sati/tool-results/<sessionId>/`）只被对应会话
 * transcript 中的 `tool_result_reference` 块引用。本脚本回收
 * 「无对应 transcript 且超过宽限期」的孤儿目录——崩溃残留、已删除
 * 会话的溢出物，通常占几十 MB～数百 MB。
 *
 * 用法：
 *   pnpm tsx scripts/trim-tool-results.ts \
 *     [--project-root .] \
 *     [--pilot-home ~/.sati] \
 *     [--older-than 30] \
 *     [--dry-run]
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { cleanupOrphanToolResults } from "../src/session/index.js";

type Args = {
  projectRoot: string;
  pilotHome: string;
  olderThanDays: number;
  dryRun: boolean;
};

function parseArgs(argv: string[]): Args {
  const get = (key: string): string | undefined => {
    const index = argv.indexOf(key);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const olderThan = Number(get("--older-than"));
  return {
    projectRoot: resolve(get("--project-root") ?? "."),
    pilotHome: get("--pilot-home") ?? resolve(homedir(), ".sati"),
    olderThanDays: Number.isFinite(olderThan) && olderThan > 0 ? olderThan : 30,
    dryRun: argv.includes("--dry-run"),
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(resolve(args.projectRoot, ".sati"))) {
    console.log(`No .sati directory under ${args.projectRoot} — nothing to trim.`);
    return;
  }
  const result = await cleanupOrphanToolResults({
    projectRoot: args.projectRoot,
    pilotHome: args.pilotHome,
    orphanGraceMs: args.olderThanDays * 24 * 60 * 60 * 1000,
    dryRun: args.dryRun,
  });
  const verb = args.dryRun ? "would remove" : "removed";
  console.log(
    `[sati] ${args.dryRun ? "[dry-run] " : ""}${verb} ${result.removed} orphaned tool-results director${
      result.removed === 1 ? "y" : "ies"
    } (retained ${result.retained}); removed: ${result.removedIds.length ? result.removedIds.join(", ") : "(none)"}`,
  );
}

main().catch(error => {
  console.error("[sati] trim-tool-results failed:", error);
  process.exitCode = 1;
});
