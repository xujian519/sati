import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractClaims, findDrift, parseMetrics } from "./check-debt-ledger.mjs";

const METRICS = [
  "## Top 30 大文件",
  "| 文件 | 行 |",
  "|---|---|",
  "| `src/big.ts` | 120 |",
  "## God function（单函数 ≥ 300 行）",
  "| 文件 | 函数 | 行 | 类型 |",
  "|---|---|---|---|",
  "| `src/god.ts` | `run` | 400 | function |",
].join("\n");

describe("debt ledger drift", () => {
  it("parses top files and god functions", () => {
    const metrics = parseMetrics(METRICS);
    assert.equal(metrics.topFiles.get("src/big.ts"), 120);
    assert.equal(metrics.godFunctions.get("src/god.ts::run"), 400);
  });

  it("uses the last claim per file", () => {
    const claims = extractClaims(["`src/big.ts` 100 行", "复核：`src/big.ts` 120 行"].join("\n"));
    assert.deepEqual(claims.get("src/big.ts"), { line: 2, claimed: 120 });
  });

  it("ignores historical transitions", () => {
    const claims = extractClaims("`src/big.ts` 240 → 120 行");
    assert.equal(claims.size, 0);
  });

  it("reports only real drift", () => {
    const metrics = parseMetrics(METRICS);
    const claims = extractClaims(["`src/big.ts` 99 行", "`src/big.ts` 120 行", "`src/unknown.ts` 7 行"].join("\n"));
    assert.deepEqual(findDrift(metrics, claims), []);
    const stale = extractClaims("`src/big.ts` 99 行");
    assert.deepEqual(findDrift(metrics, stale), [{ file: "src/big.ts", line: 1, claimed: 99, actual: 120 }]);
  });
});
