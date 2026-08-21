import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TeamLedger } from "../../../src/patent/evidence/receipt.js";
import type { Receipt } from "../../../src/patent/evidence/receipt.js";

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
