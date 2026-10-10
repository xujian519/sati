/**
 * 宿主侧续算扫描的日志接线（计划 T3a：降级但不静默）。
 *
 * `runTaskResumeScanOnce` 是 `runTaskResumeScan` 定时器回调的核心（同一生产路径）。
 * 采用与 tests/cli/team-subsystem-scan-failure.spec.ts 相同的**成对判据**：
 *   1. 失败路径：单会话提交抛错 ⇒ 返回 failed=1 且逐条 warn 留痕；
 *   2. 正常路径：提交成功 ⇒ 同样走完扫描但**不**记 warn。
 * 只测第 1 条无法证明 warn 是「失败」信号（也可能每次都打）；两条一起才钉住
 * 「同返回值、不同信号」——续算失败与「无可续算会话」必须可区分。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runTaskResumeScanOnce } from "../../src/cli/ProjectRuntimeRegistry.js";
import { getPilotProjectChatDir } from "../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../src/session/storage/ProjectSessionStorage.js";
import { logger } from "../../src/telemetry/index.js";

type JsonEntry = Record<string, unknown>;

function baseEntry(
  sessionId: string,
  turnId: string,
  sequence: number,
  type: string,
  extra: JsonEntry = {},
): JsonEntry {
  return { type, sessionId, turnId, sequence, createdAt: "2026-08-16T00:00:00.000Z", ...extra };
}

function acceptedInput(sessionId: string, turnId: string, sequence: number, text: string): JsonEntry {
  return baseEntry(sessionId, turnId, sequence, "accepted_input", {
    messages: [{ role: "user", content: [{ type: "text", text }] }],
  });
}

function requestHeader(sessionId: string, turnId: string, sequence: number): JsonEntry {
  return baseEntry(sessionId, turnId, sequence, "request_header", {
    header: {
      provider: "deepseek",
      model: "deepseek-v4-flash",
      systemPromptDigest: "abc",
      toolSchemaDigest: "def",
      messageCount: 1,
    },
  });
}

async function writeTranscript(root: string, sessionKey: string, lines: JsonEntry[]): Promise<void> {
  const chatDir = getPilotProjectChatDir(root, root);
  await mkdir(chatDir, { recursive: true });
  const path = join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
  await writeFile(path, lines.map(entry => JSON.stringify(entry)).join("\n") + "\n");
}

test("单会话提交失败：failed 计数 + 逐条 warn + 汇总 info 含 failed（失败路径必须留痕）", async t => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-host-"));
  try {
    await writeTranscript(root, "s1", [acceptedInput("s1", "t1", 1, "请分析"), requestHeader("s1", "t1", 2)]);
    const warnings: unknown[][] = [];
    const infos: unknown[][] = [];
    // 捕获日志首参，不落真实 stderr/stdout（避免污染测试输出）。
    t.mock.method(logger, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    t.mock.method(logger, "info", (...args: unknown[]) => {
      infos.push(args);
    });

    const result = await runTaskResumeScanOnce({
      projectRoot: root,
      pilotHome: root,
      submitResumeTurn: async () => {
        throw new Error("submit boom");
      },
    });

    assert.equal(result.failed, 1);
    assert.equal(result.resumed, 0, "失败路径返回值与正常空扫描一致（这正是必须靠日志区分的原因）");
    assert.equal(warnings.length, 1, "逐会话失败必须记恰好一条 warn");
    assert.match(String(warnings[0]?.[0]), /s1/);
    assert.ok(warnings[0]?.[1] instanceof Error, "warn 必须带原始 error 对象");
    assert.equal(infos.length, 1, "汇总 info 无条件记录");
    assert.match(String(infos[0]?.[0]), /failed=1/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("正常续算：不记 warn，汇总 info 含 resumed=1 / failed=0（日志是失败信号）", async t => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-host-"));
  try {
    await writeTranscript(root, "s1", [acceptedInput("s1", "t1", 1, "请分析"), requestHeader("s1", "t1", 2)]);
    const warnings: unknown[][] = [];
    const infos: unknown[][] = [];
    t.mock.method(logger, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    t.mock.method(logger, "info", (...args: unknown[]) => {
      infos.push(args);
    });

    const result = await runTaskResumeScanOnce({
      projectRoot: root,
      pilotHome: root,
      submitResumeTurn: async () => {},
    });

    assert.equal(result.resumed, 1);
    assert.equal(result.failed, 0);
    assert.equal(warnings.length, 0, "成功路径不应产出 warn");
    assert.match(String(infos[0]?.[0]), /resumed=1, failed=0/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
