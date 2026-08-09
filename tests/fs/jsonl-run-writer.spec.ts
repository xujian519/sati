import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createJsonlRunWriter } from "../../src/fs/jsonl-run-writer.js";

const tempDirs: string[] = [];

function makeWriter(): {
  append: (runId: string, line: string) => Promise<void>;
  close: (runId: string) => Promise<void>;
  pathFor: (runId: string) => string;
} {
  const dir = mkdtempSync(join(tmpdir(), "sati-jsonl-run-writer-"));
  tempDirs.push(dir);
  const pathFor = (runId: string) => join(dir, `${runId}.jsonl`);
  const writer = createJsonlRunWriter(pathFor);
  return { append: writer.append, close: writer.close, pathFor };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("createJsonlRunWriter", () => {
  it("同一 run 多次 append：全部行按序落盘", async () => {
    const { append, close, pathFor } = makeWriter();
    for (let index = 0; index < 30; index += 1) {
      await append("run-1", `line-${index}\n`);
    }
    await close("run-1");

    const lines = readFileSync(pathFor("run-1"), "utf8").trim().split("\n");
    assert.equal(lines.length, 30);
    assert.equal(lines[0], "line-0");
    assert.equal(lines[29], "line-29");
  });

  it("不同 run 写入不同文件，互不干扰", async () => {
    const { append, close, pathFor } = makeWriter();
    await append("run-a", "a\n");
    await append("run-b", "b\n");
    await close("run-a");
    await close("run-b");

    assert.equal(readFileSync(pathFor("run-a"), "utf8"), "a\n");
    assert.equal(readFileSync(pathFor("run-b"), "utf8"), "b\n");
  });

  it("未 close 时连续 append 仍完整（句柄复用），close 幂等", async () => {
    const { append, close, pathFor } = makeWriter();
    await append("run-2", "1\n");
    await append("run-2", "2\n");
    await close("run-2");
    await close("run-2"); // 幂等

    assert.equal(readFileSync(pathFor("run-2"), "utf8"), "1\n2\n");
  });

  it("close 后的 append 走新句柄，不丢失", async () => {
    const { append, close, pathFor } = makeWriter();
    await append("run-3", "第一段\n");
    await close("run-3");
    await append("run-3", "第二段\n");
    await close("run-3");

    assert.equal(readFileSync(pathFor("run-3"), "utf8"), "第一段\n第二段\n");
  });
});
