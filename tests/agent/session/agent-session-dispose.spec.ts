import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AgentSession } from "../../../src/agent/session/AgentSession.js";
import { createInitialAgentSessionState } from "../../../src/agent/session/AgentSessionState.js";
import type { AgentSessionState } from "../../../src/agent/protocol/state.js";
import type { TurnRunner } from "../../../src/agent/turn/TurnRunner.js";

/**
 * `AgentSession.dispose()`（上游 #568）：会话被 SessionRouter 驱逐或项目被关闭时
 * 的释放入口。它必须做到两件事——中止正在跑的 turn，并交出 TurnRunner 的后台
 * 工作（标题生成等）与转录写入。漏掉任一件，被驱逐的会话就会在被删目录下继续写。
 */
function fakeTurnRunner(dispose: () => Promise<void>): TurnRunner {
  return { dispose } as unknown as TurnRunner;
}

function sessionWithStatus(
  status: AgentSessionState["status"],
  turnRunner: TurnRunner,
): {
  session: AgentSession;
  state: AgentSessionState;
} {
  const state = { ...createInitialAgentSessionState("session-1"), status };
  return { session: new AgentSession({ sessionId: "session-1", turnRunner, initialState: state }), state };
}

describe("AgentSession.dispose", () => {
  it("running 会话：中止 turn（reason=session_closed）并等待 TurnRunner 释放", async () => {
    let disposed = 0;
    const { session, state } = sessionWithStatus(
      "running",
      fakeTurnRunner(async () => {
        disposed += 1;
      }),
    );

    await session.dispose();

    assert.equal(state.abortController.signal.aborted, true);
    assert.equal(state.abortController.signal.reason, "session_closed");
    assert.equal(session.snapshot().status, "aborted");
    assert.equal(disposed, 1);
  });

  it("非 running 会话：不产生中止，但仍释放 TurnRunner", async () => {
    let disposed = 0;
    const { session, state } = sessionWithStatus(
      "idle",
      fakeTurnRunner(async () => {
        disposed += 1;
      }),
    );

    await session.dispose();

    assert.equal(state.abortController.signal.aborted, false);
    assert.equal(session.snapshot().status, "idle");
    assert.equal(disposed, 1);
  });

  it("TurnRunner 缺失 dispose（旧实现）时不报错", async () => {
    const { session } = sessionWithStatus("running", {} as unknown as TurnRunner);
    await assert.doesNotReject(() => session.dispose());
  });

  it("重复 dispose 幂等：第二次不再中止，但释放调用照常透传", async () => {
    let disposed = 0;
    const { session } = sessionWithStatus(
      "running",
      fakeTurnRunner(async () => {
        disposed += 1;
      }),
    );

    await session.dispose();
    await assert.doesNotReject(() => session.dispose());

    assert.equal(disposed, 2);
    assert.equal(session.snapshot().status, "aborted");
  });
});
