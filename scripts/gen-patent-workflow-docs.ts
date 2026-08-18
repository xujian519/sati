#!/usr/bin/env tsx
/**
 * gen-patent-workflow-docs — 专利工作流单一数据源（T11）。
 *
 * 以 src/patent/workflow/manifests.ts 的 builtinPatentManifests 为唯一真相，
 * 生成 assets/workflows/patent/generated/<manifestId>.yaml 人读/审计快照：
 * 引擎执行的是 TS manifest（代码真相），YAML 只是可读镜像，杜绝"纸面 SOP 与
 * 代码脱节"的双真相漂移。
 *
 * 用法：
 *   pnpm gen:patent-workflow-docs        # 生成（写入 generated/ 目录）
 *   pnpm check:patent-workflow-docs      # --check：幂等校验（生成 diff 为空才绿）
 *
 * 幂等性：同一 manifest 输入恒生成同一 YAML（stages 顺序 = manifest 声明顺序）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { builtinPatentManifests } from "../src/patent/workflow/manifests.js";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUT_DIR = join(REPO_ROOT, "assets", "workflows", "patent", "generated");

const HEADER = [
  "# 由 scripts/gen-patent-workflow-docs.ts 从 src/patent/workflow/manifests.ts 生成——请勿手改。",
  "# 引擎执行真相：builtinPatentManifests（TS 单一数据源）；本文件为审计/人读快照。",
  "# 修改流程：编辑 manifests.ts → pnpm gen:patent-workflow-docs → 提交两处。",
].join("\n");

/** manifest → 人读 YAML 快照（仅同步引擎执行语义字段）。 */
function manifestToYaml(entry: (typeof builtinPatentManifests)[number]): string {
  const { manifest, checkDomains } = entry;
  const doc = {
    manifestId: manifest.id,
    name: manifest.name,
    caseType: manifest.caseType,
    checkDomains: [...checkDomains],
    validation: manifest.validation ?? { requireAllSteps: true, maxRetries: 2 },
    stages: manifest.stages.map(stage => ({
      id: stage.id,
      strategy: stage.strategy,
      ...(stage.atom !== undefined ? { atom: stage.atom } : {}),
      ...(stage.worker !== undefined ? { worker: stage.worker } : {}),
      ...(stage.retry !== undefined
        ? {
            retry: {
              whenOutputMatches: stage.retry.whenOutputMatches,
              rewindTo: stage.retry.rewindTo,
              maxRetries: stage.retry.maxRetries,
            },
          }
        : {}),
      description: stage.description,
    })),
  };
  return `${HEADER}\n${stringifyYaml(doc, { lineWidth: 0 })}\n`;
}

function main(): void {
  const check = process.argv.includes("--check");
  mkdirSync(OUT_DIR, { recursive: true });

  const generated = new Map<string, string>();
  for (const entry of builtinPatentManifests) {
    generated.set(`${entry.manifest.id}.yaml`, manifestToYaml(entry));
  }

  if (check) {
    const stale: string[] = [];
    for (const [file, content] of generated) {
      const path = join(OUT_DIR, file);
      let existing: string | undefined;
      try {
        existing = readFileSync(path, "utf8");
      } catch {
        // ENOENT → 视为缺失
      }
      if (existing !== content) stale.push(file);
    }
    // 反向检查：generated/ 下不应存在已删除 manifest 的孤儿文件。
    const orphans = new Set<string>();
    for (const file of [...generated.keys()]) {
      if (generated.has(file)) continue;
      orphans.add(file);
    }
    if (stale.length > 0 || orphans.size > 0) {
      console.error("check:patent-workflow-docs: 生成快照与 manifests.ts 不一致：");
      for (const f of stale) console.error(`  - 过期/缺失: ${f}（运行 pnpm gen:patent-workflow-docs）`);
      for (const f of orphans) console.error(`  - 孤儿文件: ${f}（删除或同步 manifest）`);
      process.exit(1);
    }
    console.log(`gen-patent-workflow-docs: fresh（${generated.size} 个 manifest 快照）`);
    return;
  }

  for (const [file, content] of generated) {
    writeFileSync(join(OUT_DIR, file), content, "utf8");
  }
  console.log(`gen-patent-workflow-docs: 已生成 ${generated.size} 个快照 → ${OUT_DIR}`);
}

main();
