/**
 * AgentSession 插话生命周期测试（协议 1.6）。
 *
 * 覆盖：submit 开启邮箱（run 进行中 steer 成功）、turn 收尾 drainOrClose
 * 同步关闭、滞留项广播 steer_unapplied（reason 区分 turn_ended /
 * turn_aborted）、收尾后 steer 失败。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { SteerMailbox } from "../../../src/agent/session/SteerMailbox.js";
import type { TurnRunner } from "../../../src/agent/turn/TurnRunner.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { AgentTurnResult } from "../../../src/agent/protocol/result.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

type TurnOutcome = { type: "success" | "aborted" };

/** 假 TurnRunner：run 期间 turn 状态可自定义。 */
function fakeTurnRunner(outcome: TurnOutcome): TurnRunner {
  return {
    approvePendingOutput: () => false,
    rejectPendingOutput: () => false,
    snapshotForRuntimeReload: () => ({ state: {}, cwd: "/tmp", transcriptPath: "" }),
    snapshotFileState: () => ({}),
    async *run(options: {
      sessionId: string;
      turnId: string;
      messages: CanonicalMessage[];
    }): AsyncGenerator<AgentEvent, { result: AgentTurnResult; messages: CanonicalMessage[] }> {
      yield { type: "turn_started", sessionId: options.sessionId, turnId: options.turnId };
      const result = {
        type: outcome.type,
        sessionId: options.sessionId,
        turnId: options.turnId,
        stopReason: outcome.type === "aborted" ? "aborted_streaming" : "completed",
        usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        permissionDenials: [],
        turns: 1,
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T00:00:01.000Z",
      } as AgentTurnResult;
      yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result };
      return { result, messages: options.messages };
    },
  } as unknown as TurnRunner;
}

/** wrapping runner：run 返回后、submit 收尾 drainOrClose 前注入滞留项。 */
function runnerWithLateSteer(
  outcome: TurnOutcome,
  mailbox: SteerMailbox,
  onRunning?: (mailbox: SteerMailbox) => void,
  injectLateSteer = true,
): TurnRunner {
  const base = fakeTurnRunner(outcome);
  return {
    ...base,
    async *run(options: Parameters<TurnRunner["run"]>[0]) {
      onRunning?.(mailbox);
      const generator = base.run(options);
      while (true) {
        const next = await generator.next();
        if (next.done) {
          if (injectLateSteer) {
            assert.ok(mailbox.enqueue("late-steer"));
          }
          return next.value;
        }
        yield next.value;
      }
    },
  } as unknown as TurnRunner;
}

async function collect(session: AgentSession): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const event of session.submit({ type: "text", text: "hi" })) {
    events.push(event);
  }
  return events;
}

test("run 进行中邮箱开启且 steer 成功；正常收尾无滞留即无 steer_unapplied", async () => {
  const mailbox = new SteerMailbox();
  let steeredDuringRun: string | undefined;
  const session = new AgentSession({
    sessionId: "s1",
    turnRunner: runnerWithLateSteer(
      { type: "success" },
      mailbox,
      box => {
        assert.equal(box.isOpen(), true);
        steeredDuringRun = box.enqueue("插话")?.steerId;
        // 立刻取走，模拟 loop 注入——收尾无滞留
        box.drain();
      },
      false,
    ),
    steerMailbox: mailbox,
  });

  const events = await collect(session);
  assert.ok(steeredDuringRun);
  assert.ok(!events.some(event => event.type === "steer_unapplied"));
  assert.equal(mailbox.isOpen(), false);
  // 收尾后 steer 失败
  assert.equal(session.steer("late"), undefined);
});

test("turn 正常结束的滞留项广播 steer_unapplied（turn_ended）", async () => {
  const mailbox = new SteerMailbox();
  const session = new AgentSession({
    sessionId: "s2",
    turnRunner: runnerWithLateSteer({ type: "success" }, mailbox),
    steerMailbox: mailbox,
  });

  const events = await collect(session);
  const unapplied = events.find(event => event.type === "steer_unapplied");
  assert.ok(unapplied);
  if (unapplied.type === "steer_unapplied") {
    assert.equal(unapplied.reason, "turn_ended");
    assert.equal(unapplied.preview, "late-steer");
  }
  assert.equal(mailbox.isOpen(), false);
});

test("turn 中止的滞留项广播 steer_unapplied（turn_aborted）", async () => {
  const mailbox = new SteerMailbox();
  const session = new AgentSession({
    sessionId: "s3",
    turnRunner: runnerWithLateSteer({ type: "aborted" }, mailbox),
    steerMailbox: mailbox,
  });

  const events = await collect(session);
  const unapplied = events.find(event => event.type === "steer_unapplied");
  assert.ok(unapplied);
  if (unapplied.type === "steer_unapplied") {
    assert.equal(unapplied.reason, "turn_aborted");
  }
});

test("cancelSteer/pendingSteerItems 代理到邮箱", async () => {
  const mailbox = new SteerMailbox();
  const runner = runnerWithLateSteer({ type: "success" }, mailbox, box => {
    box.enqueue("queued");
  });
  const session = new AgentSession({ sessionId: "s4", turnRunner: runner, steerMailbox: mailbox });

  const events = await collect(session);
  void events;
  // 上一 turn 已结束：新 turn 前 steer 失败（邮箱关闭）
  assert.equal(session.steer("x"), undefined);
  assert.equal(session.pendingSteerItems().length, 0);
  assert.equal(session.cancelSteer("any"), false);
});
