import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, symlinkSync } from "node:fs";
import path from "node:path";
import { createPilotDeckContractReport } from "../helpers/dualParityReport.js";
import {
  dualParityContractScenarios,
  type DualParityContractReport,
} from "../fixtures/tool/dual-parity/contractScenarios.js";

test("legacy and PilotDeck contract reports match for shared compare scenarios", () => {
  const root = process.cwd();
  ensureLegacySiblingLink(root);

  const legacyJson = execFileSync("bun", ["run", "src/pilotdeck-tool-legacy-contract-report.ts"], {
    cwd: path.join(root, "third-party/claude-code-main"),
    encoding: "utf8",
  });
  const legacyReport = JSON.parse(legacyJson) as DualParityContractReport[];
  const pilotdeckReport = createPilotDeckContractReport();

  assert.deepEqual(reportStatuses(pilotdeckReport), reportStatuses(legacyReport));

  const legacyById = new Map(legacyReport.map((item) => [item.id, item]));
  for (const pilotdeckItem of pilotdeckReport) {
    const legacyItem = legacyById.get(pilotdeckItem.id);
    assert.ok(legacyItem, `Missing legacy report item ${pilotdeckItem.id}.`);
    if (pilotdeckItem.status === "compare") {
      assert.deepEqual(pilotdeckItem.values, legacyItem.values, pilotdeckItem.id);
    }
  }
});

test("dual parity manifest covers every declared tool feature with explicit status", () => {
  const ids = new Set<string>();
  for (const scenario of dualParityContractScenarios) {
    assert.equal(ids.has(scenario.id), false, `Duplicate dual parity scenario id ${scenario.id}.`);
    ids.add(scenario.id);
    assert.ok(scenario.legacy.toolName, `${scenario.id} must declare legacy tool name.`);
    assert.ok(scenario.pilotdeck.toolName, `${scenario.id} must declare PilotDeck tool name.`);
    if (scenario.status !== "compare") {
      assert.ok(scenario.reason, `${scenario.id} must explain non-compare status.`);
    }
  }
});

function reportStatuses(report: DualParityContractReport[]): Array<Pick<DualParityContractReport, "id" | "status">> {
  return report.map((item) => ({ id: item.id, status: item.status }));
}

function ensureLegacySiblingLink(root: string): void {
  const linkPath = path.join(root, "third-party/edgeclaw-memory-core");
  const targetPath = path.join(root, "src/context/memory/edgeclaw-memory-core");
  if (!existsSync(linkPath) && existsSync(targetPath)) {
    symlinkSync("../src/context/memory/edgeclaw-memory-core", linkPath, "dir");
  }
}
