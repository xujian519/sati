import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createPolitDeckExecutionReport } from "../helpers/dualParityExecutionReport.js";
import {
  dualParityExecutionScenarios,
  type DualParityExecutionReport,
} from "../fixtures/tool/dual-parity/executionScenarios.js";

test("legacy and PolitDeck execution reports match for shared compare scenarios", async () => {
  const root = process.cwd();
  ensureLegacySiblingLink(root);

  const legacyJson = execFileSync("bun", ["run", "src/politdeck-tool-legacy-execution-report.ts"], {
    cwd: path.join(root, "third-party/claude-code-main"),
    encoding: "utf8",
  });
  const legacyReport = JSON.parse(legacyJson) as DualParityExecutionReport[];
  const politdeckReport = await createPolitDeckExecutionReport();

  assert.deepEqual(reportStatuses(politdeckReport), reportStatuses(legacyReport));

  const legacyById = new Map(legacyReport.map((item) => [item.id, item]));
  for (const politdeckItem of politdeckReport) {
    const legacyItem = legacyById.get(politdeckItem.id);
    assert.ok(legacyItem, `Missing legacy execution report item ${politdeckItem.id}.`);
    if (politdeckItem.status === "compare") {
      assert.deepEqual(politdeckItem.result, legacyItem.result, politdeckItem.id);
    }
  }
});

test("dual execution manifest has explicit status reasons for non-compare scenarios", () => {
  const ids = new Set<string>();
  for (const scenario of dualParityExecutionScenarios) {
    assert.equal(ids.has(scenario.id), false, `Duplicate dual execution scenario id ${scenario.id}.`);
    ids.add(scenario.id);
    if (scenario.status !== "compare") {
      assert.ok(scenario.reason, `${scenario.id} must explain non-compare status.`);
    }
  }
});

function reportStatuses(report: DualParityExecutionReport[]): Array<Pick<DualParityExecutionReport, "id" | "status">> {
  return report.map((item) => ({ id: item.id, status: item.status }));
}

function ensureLegacySiblingLink(root: string): void {
  const linkPath = path.join(root, "third-party/edgeclaw-memory-core");
  const targetPath = path.join(root, "edgeclaw-memory-core");
  if (!existsSync(linkPath) && existsSync(targetPath)) {
    symlinkSync("../edgeclaw-memory-core", linkPath, "dir");
  }
}
