/**
 * 离线法条快照目录定位。
 *
 * 顺序与规则资产定位同构（最具体 → 最通用）：
 * 1. `SATI_LEGAL_SNAPSHOT_DIR`（显式覆盖，需含 manifest.json）
 * 2. `<cwd>/assets/legal-snapshot`（开发 / 工作区）
 * 3. `<包根>/assets/legal-snapshot`（随包分发；构建脚本复制到 dist）
 *
 * 只有目录内确实存在 manifest.json 才视为可用——空目录不冒充快照。
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { packageRoot } from "../../../rule/runtime/asset-location.js";
import { LEGAL_SNAPSHOT_MANIFEST_FILE } from "./types.js";

const SNAPSHOT_DIR_NAME = join("assets", "legal-snapshot");

/** 候选目录（按优先级）。 */
export function candidateLegalSnapshotDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates: string[] = [];
  const envDir = env.SATI_LEGAL_SNAPSHOT_DIR;
  if (envDir) candidates.push(resolve(envDir));
  candidates.push(resolve(process.cwd(), SNAPSHOT_DIR_NAME));
  candidates.push(join(packageRoot(), SNAPSHOT_DIR_NAME));
  return candidates;
}

/** 定位可用的离线快照目录；全部候选都缺 manifest.json 时返回 undefined。 */
export function resolveLegalSnapshotDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const dir of candidateLegalSnapshotDirs(env)) {
    if (existsSync(join(dir, LEGAL_SNAPSHOT_MANIFEST_FILE))) return dir;
  }
  return undefined;
}
