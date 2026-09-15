/**
 * TurnRunner 提前终止统一收口测试（#342 / TD-AGENT-102）。
 *
 * 收口前四条失败路径各自逐行抄了同一套五步样板
 * （构造错误结果 → 结果落盘 → 收尾产物 → 记录失败状态 → 上报）。
 * 本文件逐条锁定**收口后的可观察契约**，并固定各路径的**真实差异点**：
 *
 * | 路径 | 触发 | 结果落盘 | 产物收尾 | metadata 收尾 |
 * |---|---|---|---|---|
 * | 转录落盘失败 | `recordAcceptedInput` 抛错 | 否（再写必失败） | 否（采集器未启动） | 否（标题未生成） |
 * | `UserPromptSubmit` 阻断 | hook 返回 block 效果 | 是 | 是 | 否 |
 * | 未请求模型 | `shouldCallModel === false` | 是 | 是 | 是 |
 * | loop 抛错 | `loop.run()` 抛错 | 是 | 是 | 是 |
 *
 * 另固定顺序约定：转录里 `file_artifacts` 条目先于 `turn_result`
 * （与成功路径一致，见 `tests/session/turn-file-artifacts.spec.ts`）；
 * #342 收口前「阻断」与「未请求模型」两条路径是反的，本次一并对齐。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { AgentInput } from "../../src/agent/protocol/input.js";
import type { AgentLoop, AgentLoopInput, AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import { TurnRunner } from "../../src/agent/turn/TurnRunner.js";
import type { TurnInputProcessor, TurnInputProcessorResult } from "../../src/agent/turn/TurnInputProcessor.js";
import type { LifecycleRuntime } from "../../src/lifecycle/index.js";
import type { SessionMetadataStore } from "../../src/session/metadata/SessionMetadataStore.js";
import {
  InMemoryTranscriptWriter,
  type InMemoryTranscriptEntry,
} from "../../src/session/transcript/InMemoryTranscriptWriter.js";

const SESSION_ID = "session-1";
const TURN_ID = "turn-1";

function userMessage(text = "hi") {
  return { role: "user" as const, content: [{ type: "text" as const, text }] };
}

/** 只记录被调用次数的 metadataStore 替身（P3/P4 的 metadata 收尾断言用）。 */
function fakeMetadataStore(calls: string[]): SessionMetadataStore {
  return {
    getSnapshot: () => ({}),
    record: async () => {
      calls.push("record");
    },
    reappendTail: async () => {
      calls.push("reappendTail");
    },
  } as unknown as SessionMetadataStore;
}

/** 返回 false 的输入处理器：触发「输入被接受但未请求模型」这条提前终止。 */
function noModelProcessor(): TurnInputProcessor {
  return {
    accept: (): TurnInputProcessorResult => ({ messages: [userMessage()], shouldCallModel: false }),
  } as unknown as TurnInputProcessor;
}

/** 永不返回的 loop：前三条提前终止路径都不应真正跑到模型。 */
function unreachableLoop(): AgentLoop {
  return {
    run: async () => {
      throw new Error("loop must not run on early-termination paths");
    },
    snapshotFileState: () => ({}),
  } as unknown as AgentLoop;
}

type HarnessOptions = {
  fakeLoop?: AgentLoop;
  inputProcessor?: TurnInputProcessor;
  lifecycle?: LifecycleRuntime;
  metadataStore?: SessionMetadataStore;
  transcript?: InMemoryTranscriptWriter;
};

function buildRunner(projectRoot: string, options: HarnessOptions = {}) {
  const transcript = options.transcript ?? new InMemoryTranscriptWriter();
  const runner = new TurnRunner(
    options.fakeLoop ?? unreachableLoop(),
    transcript,
    options.inputProcessor,
    () => new Date("2026-07-21T10:00:01.000Z"),
    options.lifecycle,
    { cwd: projectRoot, transcriptPath: "" },
    options.metadataStore ? { metadataStore: options.metadataStore } : {},
  );
  return { runner, transcript };
}

async function collectEvents(runner: TurnRunner, input: AgentInput = { type: "text", text: "hi" }) {
  const events: AgentEvent[] = [];
  const owned = runner.run({ sessionId: SESSION_ID, turnId: TURN_ID, messages: [], input });
  let next = await owned.next();
  while (!next.done) {
    events.push(next.value);
    next = await owned.next();
  }
  return { events, runResult: next.value };
}

function entryTypes(entries: InMemoryTranscriptEntry[]): string[] {
  return entries.map(entry => entry.type);
}

/** 四条路径共有的尾部序列：失败状态 → turn_failed → turn_completed。 */
function assertCommonFailureTail(events: AgentEvent[]): void {
  const tail = events.slice(-3).map(event => event.type);
  assert.deepEqual(tail, ["agent_status", "turn_failed", "turn_completed"], `尾部序列异常：${events.map(e => e.type)}`);
  const status = events.at(-3);
  assert.equal(status?.type === "agent_status" && status.event, "turn_failed");
}

test("#342 转录落盘失败：只上报失败，不落结果、不产生产物、不做 metadata 收尾", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-early-transcript-"));
  try {
    class FailingAcceptedInput extends InMemoryTranscriptWriter {
      override recordAcceptedInput(): void {
        throw new Error("transcript unavailable");
      }
    }
    const transcript = new FailingAcceptedInput();
    const { runner } = buildRunner(projectRoot, { transcript });

    const { events, runResult } = await collectEvents(runner);

    assert.deepEqual(
      events.map(event => event.type),
      ["turn_started", "agent_status", "turn_failed", "turn_completed"],
    );
    assert.equal(runResult.result.type, "error");
    // 结果无法落盘（转录已坏）、采集器尚未启动、标题未生成。
    assert.deepEqual(entryTypes(transcript.entries), ["agent_status_message"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("#342 UserPromptSubmit 阻断：结果落盘 + 产物收尾，但无 metadata 收尾", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-early-block-"));
  try {
    const metadataCalls: string[] = [];
    const lifecycle = {
      dispatch: async () => {
        // 采集器基线已在 input_accepted 之后建立，此处产生的文件算本回合产物。
        await writeFile(join(projectRoot, "blocked-artifact.txt"), "hook side effect");
        return {
          effects: [{ type: "block", reason: "hook said no" }],
          messages: [],
          events: [],
          blockingErrors: [],
          nonBlockingErrors: [],
        };
      },
    } as unknown as LifecycleRuntime;
    const { runner, transcript } = buildRunner(projectRoot, {
      lifecycle,
      metadataStore: fakeMetadataStore(metadataCalls),
    });

    const { events, runResult } = await collectEvents(runner);

    assert.deepEqual(
      events.map(event => event.type),
      [
        "turn_started",
        "input_accepted",
        "user_prompt_submitted",
        "file_artifacts",
        "agent_status",
        "turn_failed",
        "turn_completed",
      ],
    );
    assertCommonFailureTail(events);
    assert.equal(runResult.result.type, "error");
    // 阻断发生在标题生成之前：不应有 metadata 收尾。
    assert.equal(metadataCalls.includes("reappendTail"), false, `不该做 metadata 收尾：${metadataCalls.join(",")}`);
    const types = entryTypes(transcript.entries);
    assert.ok(types.includes("turn_result"), "阻断路径应把错误结果落盘");
    assert.ok(
      types.indexOf("file_artifacts") < types.indexOf("turn_result"),
      `产物条目应先于结果条目：${types.join(" → ")}`,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("#342 未请求模型：结果落盘 + 产物收尾 + metadata 收尾", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-early-nomodel-"));
  try {
    const metadataCalls: string[] = [];
    const lifecycle = {
      dispatch: async () => {
        await writeFile(join(projectRoot, "hook-artifact.txt"), "hook side effect");
        return { effects: [], messages: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
      },
    } as unknown as LifecycleRuntime;
    const { runner, transcript } = buildRunner(projectRoot, {
      inputProcessor: noModelProcessor(),
      lifecycle,
      metadataStore: fakeMetadataStore(metadataCalls),
    });

    const { events, runResult } = await collectEvents(runner);

    assert.deepEqual(
      events.map(event => event.type),
      [
        "turn_started",
        "input_accepted",
        "user_prompt_submitted",
        "file_artifacts",
        "agent_status",
        "turn_failed",
        "turn_completed",
      ],
    );
    assertCommonFailureTail(events);
    assert.equal(runResult.result.type, "error");
    assert.equal(metadataCalls.includes("reappendTail"), true, "该路径应做 metadata 收尾");
    const types = entryTypes(transcript.entries);
    assert.ok(types.includes("turn_result"));
    assert.ok(
      types.indexOf("file_artifacts") < types.indexOf("turn_result"),
      `产物条目应先于结果条目：${types.join(" → ")}`,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("#342 loop 抛错：结果落盘 + 产物收尾 + metadata 收尾", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-early-loopthrow-"));
  try {
    const metadataCalls: string[] = [];
    const throwingLoop = {
      // eslint-disable-next-line require-yield -- 故意不 yield：本替身要在第一次 next() 就抛错，模拟 loop 运行中崩溃
      async *run(input: AgentLoopInput): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
        await writeFile(join(projectRoot, "loop-artifact.txt"), "tool side effect");
        throw new Error(`loop exploded for ${input.turnId}`);
      },
      snapshotFileState: () => ({}),
    } as unknown as AgentLoop;
    const { runner, transcript } = buildRunner(projectRoot, {
      fakeLoop: throwingLoop,
      metadataStore: fakeMetadataStore(metadataCalls),
    });

    const { events, runResult } = await collectEvents(runner);

    assert.deepEqual(
      events.map(event => event.type),
      [
        "turn_started",
        "input_accepted",
        "user_prompt_submitted",
        "file_artifacts",
        "agent_status",
        "turn_failed",
        "turn_completed",
      ],
    );
    assertCommonFailureTail(events);
    assert.equal(runResult.result.type, "error");
    assert.equal(metadataCalls.includes("reappendTail"), true);
    const types = entryTypes(transcript.entries);
    assert.ok(types.includes("turn_result"));
    assert.ok(
      types.indexOf("file_artifacts") < types.indexOf("turn_result"),
      `产物条目应先于结果条目：${types.join(" → ")}`,
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("#342 收口后每条失败路径只产生一个 turn_result 与一个失败状态事件", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "sati-early-single-"));
  try {
    const lifecycle = {
      dispatch: async () => ({
        effects: [{ type: "block", reason: "hook said no" }],
        messages: [],
        events: [],
        blockingErrors: [],
        nonBlockingErrors: [],
      }),
    } as unknown as LifecycleRuntime;
    const { runner, transcript } = buildRunner(projectRoot, { lifecycle });

    const { events, runResult } = await collectEvents(runner);

    assert.equal(events.filter(event => event.type === "turn_completed").length, 1);
    assert.equal(events.filter(event => event.type === "turn_failed").length, 1);
    assert.equal(transcript.entries.filter(entry => entry.type === "turn_result").length, 1);
    assert.equal(transcript.entries.filter(entry => entry.type === "agent_status_message").length, 1);
    // turn_completed 携带的 result 必须与 return 值一致（消费者两条路都读）。
    const completed = events.find(event => event.type === "turn_completed");
    assert.ok(completed?.type === "turn_completed");
    assert.equal(completed.result, runResult.result);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});
