import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeOaRoundSnapshot } from "../../../src/patent/oa/round-snapshot.js";
import { DraftOaHandler } from "../../../src/patent/atoms/handlers/builtin/oa.js";
import type { StageProvider } from "../../../src/patent/atoms/index.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "oa-rounds-test-"));
}

test("writeOaRoundSnapshot: 连续两次写入 round-1 / round-2，第一轮字节不变", async () => {
  const cwd = tempDir();
  try {
    const first = await writeOaRoundSnapshot({
      caseId: "case-1",
      cwd,
      artifacts: [{ name: "oa_statement.json", content: "first" }],
    });
    assert.equal(first.round, 1);
    const firstFile = join(first.dir, "oa_statement.json");
    assert.equal(readFileSync(firstFile, "utf8"), "first");

    const second = await writeOaRoundSnapshot({
      caseId: "case-1",
      cwd,
      artifacts: [{ name: "oa_statement.json", content: "second" }],
    });
    assert.equal(second.round, 2);
    assert.equal(readFileSync(firstFile, "utf8"), "first");
    assert.equal(readFileSync(join(second.dir, "oa_statement.json"), "utf8"), "second");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeOaRoundSnapshot: 拒绝非法 caseId，不创建目录", async () => {
  const cwd = tempDir();
  try {
    await assert.rejects(
      () => writeOaRoundSnapshot({ caseId: "../escape", cwd, artifacts: [{ name: "a", content: "x" }] }),
      RangeError,
    );
    assert.equal(readdirSafe(cwd).length, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("writeOaRoundSnapshot: 拒绝空 artifacts", async () => {
  const cwd = tempDir();
  try {
    await assert.rejects(() => writeOaRoundSnapshot({ caseId: "case-1", cwd, artifacts: [] }), RangeError);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function readdirSafe(path: string): string[] {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
}

test("DraftOaHandler: 有 caseId 时落盘并回填 round-N", async () => {
  const cwd = tempDir();
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    const provider: StageProvider = {
      caseId: "case-1",
      callLLM: async () => JSON.stringify({ notes: [] }),
    };
    const state = await new DraftOaHandler().execute({
      state: {
        claim_chart_doc: JSON.stringify({
          claim: "一种装置，包括壳体。",
          elements: [{ id: "1a", claimNo: 1, text: "包括壳体", kind: "limitation" }],
          targets: [{ id: "D1", kind: "prior-art" }],
          rows: [],
          gaps: [],
        }),
        amendment_diff: JSON.stringify({ status: "checked", items: [] }),
      },
      provider,
    });
    const statement = JSON.parse(state.oa_statement as string) as { snapshot?: string };
    assert.equal(statement.snapshot, "round-1");
    assert.equal(
      readFileSync(join(cwd, "data/cases/case-1/oa-rounds/round-1/oa_statement.json"), "utf8").includes("draft"),
      true,
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("DraftOaHandler: 无 caseId 时标记 skipped-no-case，不创建目录", async () => {
  const cwd = tempDir();
  const originalCwd = process.cwd();
  try {
    process.chdir(cwd);
    const provider: StageProvider = { callLLM: async () => JSON.stringify({ notes: [] }) };
    const state = await new DraftOaHandler().execute({
      state: {
        claim_chart_doc: JSON.stringify({ elements: [], targets: [], rows: [], gaps: [] }),
        amendment_diff: JSON.stringify({ status: "checked", items: [] }),
      },
      provider,
    });
    const statement = JSON.parse(state.oa_statement as string) as { snapshot?: string };
    assert.equal(statement.snapshot, "skipped-no-case");
    assert.equal(readdirSafe(cwd).length, 0);
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});
