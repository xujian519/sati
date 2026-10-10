/**
 * 跨进程重启续算 T-C：TaskResumeScanner 扫描/判定/提交（fixture 驱动）。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getPilotProjectChatDir } from "../../../src/pilot/index.js";
import { sanitizeSessionIdForPath } from "../../../src/session/storage/ProjectSessionStorage.js";
import {
  RESUME_TURN_MARKER,
  RESUME_TURN_MESSAGE,
  TaskResumeScanner,
} from "../../../src/session/resume/TaskResumeScanner.js";
import { logger } from "../../../src/telemetry/index.js";

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
  await writeFile(path, lines.map(l => JSON.stringify(l)).join("\n") + "\n");
}

async function withScanner(
  root: string,
  options: { hasPendingApprovals?: (sessionKey: string) => boolean; submittedKeys?: Set<string> } = {},
): Promise<{ result: Awaited<ReturnType<TaskResumeScanner["scan"]>>; submitted: string[] }> {
  const submitted: string[] = [];
  const scanner = new TaskResumeScanner({
    projectRoot: root,
    pilotHome: root,
    submitResumeTurn: async sessionKey => {
      submitted.push(sessionKey);
    },
    hasPendingApprovals: options.hasPendingApprovals,
    submittedKeys: options.submittedKeys,
  });
  const result = await scanner.scan();
  return { result, submitted };
}

test("续算常量：标记前缀与消息", () => {
  assert.ok(RESUME_TURN_MESSAGE.startsWith(RESUME_TURN_MARKER));
  assert.match(RESUME_TURN_MESSAGE, /继续完成/);
});

test("(a) 形态：request_header 后无 durable → 提交续算 turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [
      acceptedInput("s1", "t1", 1, "请分析这份专利的权利要求"),
      requestHeader("s1", "t1", 2),
    ]);
    const { result, submitted } = await withScanner(root);
    assert.equal(result.scanned, 1);
    assert.equal(result.resumed, 1);
    assert.deepEqual(submitted, ["s1"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("已闭合会话（有 turn_result）不提交", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [
      acceptedInput("s1", "t1", 1, "你好"),
      requestHeader("s1", "t1", 2),
      baseEntry("s1", "t1", 3, "turn_result", { result: { type: "completed", stopReason: "completed" } }),
    ]);
    const { result, submitted } = await withScanner(root);
    assert.equal(result.resumed, 0);
    assert.deepEqual(submitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("(b) 形态：request_header 后已有部分 durable → 跳过（skippedPartial）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [
      acceptedInput("s1", "t1", 1, "请分析"),
      requestHeader("s1", "t1", 2),
      baseEntry("s1", "t1", 3, "durable_message", {
        message: { role: "assistant", content: [{ type: "text", text: "部分响应" }] },
      }),
    ]);
    const { result, submitted } = await withScanner(root);
    assert.equal(result.skippedPartial, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(submitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("有挂起审批的会话跳过（skippedApprovals）", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [acceptedInput("s1", "t1", 1, "请分析"), requestHeader("s1", "t1", 2)]);
    const { result, submitted } = await withScanner(root, {
      hasPendingApprovals: sessionKey => sessionKey === "s1",
    });
    assert.equal(result.skippedApprovals, 1);
    assert.equal(result.resumed, 0);
    assert.deepEqual(submitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("submittedKeys 防本次启动重复提交", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [acceptedInput("s1", "t1", 1, "请分析"), requestHeader("s1", "t1", 2)]);
    const submittedKeys = new Set<string>(["s1"]);
    const { result, submitted } = await withScanner(root, { submittedKeys });
    assert.equal(result.resumed, 0);
    assert.deepEqual(submitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("空 chatDir 零提交", async () => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    const { result, submitted } = await withScanner(root);
    assert.equal(result.scanned, 0);
    assert.equal(result.resumed, 0);
    assert.deepEqual(submitted, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("提交失败的会话：failed 计数 + warn 留痕，其余会话不受影响", async t => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [acceptedInput("s1", "t1", 1, "请分析甲"), requestHeader("s1", "t1", 2)]);
    await writeTranscript(root, "s2", [acceptedInput("s2", "t1", 1, "请分析乙"), requestHeader("s2", "t1", 2)]);
    const warnings: unknown[][] = [];
    t.mock.method(logger, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    const submitted: string[] = [];
    const scanner = new TaskResumeScanner({
      projectRoot: root,
      pilotHome: root,
      submitResumeTurn: async sessionKey => {
        if (sessionKey === "s1") throw new Error("submit boom");
        submitted.push(sessionKey);
      },
    });
    const result = await scanner.scan();
    assert.equal(result.failed, 1, "失败会话必须计入 failed");
    assert.equal(result.resumed, 1, "单个失败不得阻塞其余会话");
    assert.deepEqual(submitted, ["s2"]);
    assert.equal(warnings.length, 1, "失败会话必须记恰好一条 warn（否则失败与『无可续算』不可区分）");
    assert.match(String(warnings[0]?.[0]), /s1/);
    assert.ok(warnings[0]?.[1] instanceof Error, "日志必须带原始 error");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("正常扫描不记 warn（日志是失败信号，不是每次都打）", async t => {
  const root = await mkdtemp(join(tmpdir(), "sati-resume-scan-"));
  try {
    await writeTranscript(root, "s1", [acceptedInput("s1", "t1", 1, "请分析"), requestHeader("s1", "t1", 2)]);
    const warnings: unknown[][] = [];
    t.mock.method(logger, "warn", (...args: unknown[]) => {
      warnings.push(args);
    });
    const { result } = await withScanner(root);
    assert.equal(result.resumed, 1);
    assert.equal(result.failed, 0);
    assert.equal(warnings.length, 0, "成功路径不应产出 warn");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
