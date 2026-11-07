/**
 * 答复轮次快照：把一轮答复的前后文本落到
 * `<cwd>/data/cases/<caseId>/oa-rounds/round-N/`。
 *
 * 只追加、不覆盖：每轮目录独占，旧轮次字节不变。这里不读也不写
 * `patent_docket` 状态——`recordRevision` 要求 `answered` 命中未决缺口，
 * 自动跑完一轮答复不等于「人已回答缺口」，不能借道案卷状态机。
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertSafeId } from "../persist-utils.js";
import { caseOaRoundsDir } from "../paths.js";

export type OaRoundArtifact = {
  /** 产物文件名（仅展示与命名用，写入前清洗）。 */
  name: string;
  content: string;
};

export type WriteOaRoundSnapshotInput = {
  caseId: string;
  artifacts: readonly OaRoundArtifact[];
  /** 案例根目录的父目录（缺省 `process.cwd()`）。 */
  cwd?: string;
};

export type OaRoundSnapshot = {
  round: number;
  dir: string;
};

/** 清洗产物文件名：只保留安全字符集，空结果退回 artifact-N。 */
function safeArtifactName(name: string, index: number): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^\.+/, "");
  return cleaned === "" ? `artifact-${index}` : cleaned.slice(0, 120);
}

const ROUND_DIR = /^round-(\d+)$/;

/** 读取已有轮次编号（缺失目录返回空数组）。 */
async function existingRounds(root: string): Promise<number[]> {
  try {
    const entries = await readdir(root, { withFileTypes: true });
    return entries
      .filter(entry => entry.isDirectory())
      .map(entry => ROUND_DIR.exec(entry.name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map(match => Number(match[1]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/**
 * 写入一轮快照。
 *
 * 并发调用时 `mkdir` 会因目录已存在而失败（`recursive: false`），据此
 * 顺延到下一个编号，保证同一轮次不会被两个调用同时覆盖。
 */
export async function writeOaRoundSnapshot(input: WriteOaRoundSnapshotInput): Promise<OaRoundSnapshot> {
  assertSafeId(input.caseId, "caseId");
  if (input.artifacts.length === 0) {
    throw new RangeError("writeOaRoundSnapshot: artifacts 不能为空");
  }

  const base = join(input.cwd ?? process.cwd(), caseOaRoundsDir(input.caseId));
  await mkdir(base, { recursive: true });

  const used = await existingRounds(base);
  let round = (used.length > 0 ? Math.max(...used) : 0) + 1;
  let dir = join(base, `round-${round}`);

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await mkdir(dir, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      round += 1;
      dir = join(base, `round-${round}`);
    }
  }

  const names = new Set<string>();
  for (const [index, artifact] of input.artifacts.entries()) {
    let name = safeArtifactName(artifact.name, index);
    if (names.has(name)) {
      name = `${index}-${name}`;
    }
    names.add(name);
    await writeFile(join(dir, name), artifact.content, { encoding: "utf8", flag: "wx" });
  }

  return { round, dir };
}
