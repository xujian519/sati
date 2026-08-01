/**
 * 向量索引持久化（JSONL）。
 *
 * 行格式：`{ id, textHash, updatedAt, vector: number[] }`。
 * 体量说明：wiki 1548 卡 × 1024 维 ≈ 20MB，记忆文件数百个 ≈ 数 MB，
 * JSON 序列化可接受；阶段 B 的大规模 KG/法条索引改用 SQLite BLOB + int8。
 */

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type StoredVectorRow = {
  id: string;
  textHash: string;
  updatedAt: string;
  vector: number[];
};

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function loadVectorRows(path: string): StoredVectorRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  const rows: StoredVectorRow[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as StoredVectorRow;
      if (typeof parsed.id === "string" && typeof parsed.textHash === "string" && Array.isArray(parsed.vector)) {
        rows.push(parsed);
      }
    } catch {
      // 跳过损坏行（不阻断启动）
    }
  }
  return rows;
}

export function rewriteVectorRows(path: string, rows: StoredVectorRow[]): void {
  mkdirSync(dirname(path), { recursive: true });
  if (rows.length === 0) {
    writeFileSync(path, "", "utf8");
    return;
  }
  const lines = rows.map(row => JSON.stringify(row));
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
}
