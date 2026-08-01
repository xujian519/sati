import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadVectorRows, rewriteVectorRows, sha256Text } from "../../../src/context/vector/jsonl-store.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "sati-jsonl-"));
}

describe("jsonl-store", () => {
  it("rewrite + load 往返一致", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "v.jsonl");
      rewriteVectorRows(path, [
        { id: "a", textHash: "h1", updatedAt: "2026-01-01", vector: [0.1, 0.2] },
        { id: "b", textHash: "h2", updatedAt: "2026-01-02", vector: [0.3, 0.4, 0.5] },
      ]);
      const rows = loadVectorRows(path);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.id, "a");
      assert.deepEqual(rows[0]!.vector, [0.1, 0.2]);
      assert.equal(rows[1]!.textHash, "h2");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("文件缺失返回空数组", () => {
    const rows = loadVectorRows(join(makeTempDir(), "nope.jsonl"));
    assert.deepEqual(rows, []);
  });

  it("损坏行被跳过", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "v.jsonl");
      writeFileSync(
        path,
        '{"id":"a","textHash":"h","updatedAt":"t","vector":[1]}\nNOT_JSON\n{"id":"b","textHash":"h2","updatedAt":"t","vector":[2]}\n',
        "utf8",
      );
      const rows = loadVectorRows(path);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.id, "a");
      assert.equal(rows[1]!.id, "b");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("空数组写入后文件为空字符串", () => {
    const dir = makeTempDir();
    try {
      const path = join(dir, "v.jsonl");
      rewriteVectorRows(path, []);
      assert.deepEqual(loadVectorRows(path), []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("sha256Text 稳定且对内容敏感", () => {
    assert.equal(sha256Text("abc"), sha256Text("abc"));
    assert.notEqual(sha256Text("abc"), sha256Text("abd"));
  });
});
