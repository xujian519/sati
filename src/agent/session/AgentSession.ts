import { randomUUID } from "node:crypto";
import type { AgentEvent } from "../protocol/events.js";
import type { AgentInput, AgentSubmitOptions } from "../protocol/input.js";
import type { AgentSessionState as AgentSessionStateShape } from "../protocol/state.js";
import type { TurnRunner } from "../turn/TurnRunner.js";
import {
  appendPermissionDenials,
  createInitialAgentSessionState,
  mergeSessionUsage,
  snapshotAgentSessionState,
} from "./AgentSessionState.js";

export type AgentSessionOptions = {
  sessionId: string;
  turnRunner: TurnRunner;
  uuid?: () => string;
};

export class AgentSession {
  private state: AgentSessionStateShape;

  constructor(private readonly options: AgentSessionOptions) {
    this.state = createInitialAgentSessionState(options.sessionId);
  }

  async *submit(input: AgentInput, submitOptions: AgentSubmitOptions = {}): AsyncGenerator<AgentEvent, void, unknown> {
    const turnId = submitOptions.turnId ?? this.nextId();
    this.state.status = "running";
    this.state.currentTurnId = turnId;
    this.state.abortController = new AbortController();
    yield { type: "session_started", sessionId: this.state.sessionId };

    const runResult = yield* this.options.turnRunner.run({
      sessionId: this.state.sessionId,
      turnId,
      messages: this.state.messages,
      input,
      maxTurns: submitOptions.maxTurns,
      abortSignal: this.state.abortController.signal,
    });

    this.state.messages = runResult.messages;
    this.state.usage = mergeSessionUsage(this.state.usage, runResult.result.usage);
    this.state.permissionDenials = appendPermissionDenials(
      this.state.permissionDenials,
      runResult.result.permissionDenials,
    );
    this.state.status = runResult.result.type === "aborted" ? "aborted" : runResult.result.type === "error" ? "failed" : "idle";
    this.state.currentTurnId = undefined;
  }

  abort(reason?: string): void {
    this.state.abortController.abort(reason);
    this.state.status = "aborted";
  }

  snapshot(): AgentSessionStateShape {
    return snapshotAgentSessionState(this.state);
  }

  private nextId(): string {
    return this.options.uuid?.() ?? randomUUID();
  }
}
