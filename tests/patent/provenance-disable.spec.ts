import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { caseProvenanceDir } from "../../src/patent/paths.js";
import { isProvenanceEnabled } from "../../src/patent/provenance/config.js";
import { openProvenanceCollector } from "../../src/tool/builtin/patentWorkflowRunTool.js";

function withEnv<T>(value: string | undefined, fn: () => T): T {
  const original = process.env.SATI_PROVENANCE;
  if (value === undefined) delete process.env.SATI_PROVENANCE;
  else process.env.SATI_PROVENANCE = value;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.SATI_PROVENANCE;
    else process.env.SATI_PROVENANCE = original;
  }
}

test("isProvenanceEnabled：默认关；SATI_PROVENANCE=1 开；程序化配置优先", () => {
  withEnv(undefined, () => {
    assert.equal(isProvenanceEnabled(), false);
    assert.equal(isProvenanceEnabled({ env: { SATI_PROVENANCE: "1" } }), true);
    assert.equal(isProvenanceEnabled({ enableProvenance: true }), true);
    assert.equal(isProvenanceEnabled({ enableProvenance: false, env: { SATI_PROVENANCE: "1" } }), false);
  });
  withEnv("1", () => {
    assert.equal(isProvenanceEnabled(), true);
  });
});

test("零写入回归：开关关时 openProvenanceCollector → null 且不创建任何库文件", () => {
  withEnv(undefined, () => {
    const cwd = mkdtempSync(join(tmpdir(), "provenance-disable-"));
    try {
      const collector = openProvenanceCollector({
        caseId: "case-1",
        cwd,
        runKey: "patent_drafting_v1",
        resume: false,
      });
      assert.equal(collector, null);
      // 零写入：per-case 库目录与 run-id 元信息均未创建
      assert.equal(existsSync(join(caseProvenanceDir("case-1", cwd), "provenance.db")), false);
      assert.equal(existsSync(join(caseProvenanceDir("case-1", cwd), "patent_drafting_v1.run.json")), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
