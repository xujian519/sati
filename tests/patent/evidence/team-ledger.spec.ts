import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamLedger } from "../../../src/patent/evidence/receipt.js";
import type { Receipt, TeamEvidenceDeclaration } from "../../../src/patent/evidence/receipt.js";

function receipt(overrides: Partial<Receipt> = {}): Receipt {
  return {
    toolCallId: "tc-1",
    turnId: "turn-1",
    toolName: "patent_search",
    args: { query: "q" },
    success: true,
    startedAt: "2026-08-21T00:00:00.000Z",
    write: false,
    resultText: "hits",
    ...overrides,
  };
}

function tempLedgerPath(): { dir: string; filePath: string } {
  const dir = mkdtempSync(join(tmpdir(), "team-ledger-"));
  return { dir, filePath: join(dir, "evidence-ledger.jsonl") };
}

test("TeamLedger: 跨实例共享——新实例读取已落盘历史", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const first = new TeamLedger(filePath);
    first.record(receipt({ toolCallId: "a" }));
    first.record(receipt({ toolCallId: "b", toolName: "paper_search" }));

    const second = new TeamLedger(filePath);
    assert.equal(second.size(), 2);
    assert.deepEqual(
      second.list().map(r => r.toolCallId),
      ["a", "b"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamLedger: 按 toolCallId 去重（resume 重放不重复写）", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const ledger = new TeamLedger(filePath);
    ledger.record(receipt({ toolCallId: "dup" }));
    ledger.record(receipt({ toolCallId: "dup", toolName: "patent_metadata" }));
    assert.equal(ledger.size(), 1);

    const raw = readFileSync(filePath, "utf8");
    assert.equal(raw.trim().split("\n").length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamLedger: reset 从文件刷新（保留历史，模拟每 turn startTurn）", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const ledger = new TeamLedger(filePath);
    ledger.record(receipt({ toolCallId: "keep" }));
    ledger.reset();
    assert.equal(ledger.size(), 1);
    assert.equal(ledger.list()[0]!.toolCallId, "keep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamLedger: 文件不存在时正常创建；坏行跳过", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const ledger = new TeamLedger(filePath);
    assert.equal(ledger.size(), 0);
    ledger.record(receipt({ toolCallId: "ok" }));

    // 追加一行坏 JSON，重新加载应跳过坏行保留好行。
    appendFileSync(filePath, "{broken json\n", "utf8");
    const reloaded = new TeamLedger(filePath);
    assert.equal(reloaded.size(), 1);
    assert.equal(reloaded.list()[0]!.toolCallId, "ok");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function declaration(
  memberId: string,
  claimId: string,
  direction: TeamEvidenceDeclaration["direction"],
): TeamEvidenceDeclaration {
  return {
    kind: "declaration",
    memberId,
    claimId,
    direction,
    declaredAt: "2026-08-21T00:00:00.000Z",
  };
}

test("TeamLedger: 证据声明持久化并跨实例共享", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const first = new TeamLedger(filePath);
    first.declareEvidence(declaration("researcher", "t2-新颖性", "supporting"));
    first.declareEvidence(declaration("invalidity-petitioner", "t2-新颖性", "contradicting"));

    const second = new TeamLedger(filePath);
    assert.equal(second.listDeclarations().length, 2);
    assert.deepEqual(
      second.listDeclarations().map(d => d.memberId),
      ["researcher", "invalidity-petitioner"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamLedger: detectTeamConflicts 检测 claim 分叉与 source 冲突", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const ledger = new TeamLedger(filePath);
    ledger.declareEvidence(declaration("researcher", "t2-新颖性", "supporting"));
    ledger.declareEvidence(declaration("invalidity-petitioner", "t2-新颖性", "contradicting"));
    // source 冲突：同一来源被不同成员反向引用。
    ledger.declareEvidence({
      kind: "declaration",
      memberId: "researcher",
      claimId: "t3-创造性",
      direction: "supporting",
      sourceUri: "patent:CN1234567A",
      declaredAt: "2026-08-21T00:00:00.000Z",
    });
    ledger.declareEvidence({
      kind: "declaration",
      memberId: "tech-investigator",
      claimId: "t3-创造性",
      direction: "contradicting",
      sourceUri: "patent:CN1234567A",
      declaredAt: "2026-08-21T00:00:00.000Z",
    });

    const conflicts = ledger.detectTeamConflicts();
    // 3 个冲突：claim t2-新颖性 分叉、claim t3-创造性 分叉、source patent:CN1234567A 反向引用。
    assert.equal(conflicts.length, 3);
    const claimT2 = conflicts.find(c => c.type === "claim" && c.subject === "t2-新颖性");
    const claimT3 = conflicts.find(c => c.type === "claim" && c.subject === "t3-创造性");
    const source = conflicts.find(c => c.type === "source");
    assert.ok(claimT2);
    assert.deepEqual(claimT2.supporting, ["researcher"]);
    assert.deepEqual(claimT2.contradicting, ["invalidity-petitioner"]);
    assert.ok(claimT3);
    assert.deepEqual(claimT3.contradicting, ["tech-investigator"]);
    assert.ok(source);
    assert.equal(source.subject, "patent:CN1234567A");
    assert.deepEqual(source.supporting, ["researcher"]);
    assert.deepEqual(source.contradicting, ["tech-investigator"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("TeamLedger: 声明去重 + reset 后从文件重载", () => {
  const { dir, filePath } = tempLedgerPath();
  try {
    const ledger = new TeamLedger(filePath);
    ledger.declareEvidence(declaration("researcher", "t1", "supporting"));
    ledger.declareEvidence(declaration("researcher", "t1", "supporting"));
    assert.equal(ledger.listDeclarations().length, 1);
    assert.equal(readFileSync(filePath, "utf8").trim().split("\n").length, 1);

    ledger.reset();
    assert.equal(ledger.listDeclarations().length, 1);
    assert.equal(ledger.listDeclarations()[0]!.memberId, "researcher");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
