import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentTurnResult } from "../../agent/index.js";
import type { CanonicalModelEvent } from "../../model/index.js";
import { contentToText } from "../../tool/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import type {
  Gateway,
  GatewayEvent,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
} from "../protocol/types.js";

export type InProcessGatewayOptions = {
  now?: () => Date;
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
};

export class InProcessGateway implements Gateway {
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(
    private readonly router: SessionRouter,
    private readonly options: InProcessGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  async *submitTurn(input: GatewaySubmitTurnInput): AsyncIterable<GatewayEvent> {
    const runId = input.runId ?? this.uuid();
    if (!this.router.beginTurn(input.sessionKey, runId)) {
      yield {
        type: "error",
        code: "session_busy",
        message: `Session ${input.sessionKey} already has an active turn.`,
        recoverable: true,
      };
      return;
    }

    try {
      const session = await this.router.getOrCreate({
        sessionKey: input.sessionKey,
        projectKey: input.projectKey,
        channelKey: input.channelKey,
      });

      for await (const event of session.submit({ type: "text", text: input.message }, { turnId: runId })) {
        for (const gatewayEvent of mapAgentEvent(event, runId)) {
          yield gatewayEvent;
        }
      }
    } catch (error) {
      yield {
        type: "error",
        code: "gateway_submit_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: false,
      };
    } finally {
      this.router.endTurn(input.sessionKey, runId);
    }
  }

  async abortTurn(input: { sessionKey: string; runId?: string }): Promise<void> {
    await this.router.abort(input.sessionKey, input.runId ? `aborted:${input.runId}` : "aborted");
  }

  async listSessions(input: ListSessionsInput): Promise<ListSessionsResult> {
    return this.router.list(input);
  }

  async resumeSession(input: { sessionKey: string }): Promise<{ sessionKey: string }> {
    return input;
  }

  async newSession(input: NewSessionInput): Promise<{ sessionKey: string }> {
    const suffix = this.uuid();
    const projectKey = input.projectKey ? `project=${input.projectKey}:` : "";
    return { sessionKey: `${input.channelKey}:${projectKey}s_${suffix}` };
  }

  async closeSession(input: { sessionKey: string; reason?: string }): Promise<void> {
    await this.router.close(input.sessionKey);
  }

  async describeServer(): Promise<GatewayServerInfo> {
    return {
      mode: "in_process",
      sessionCount: this.router.sessionCount(),
      ...this.options.serverInfo,
    };
  }
}

export function mapAgentEvent(event: AgentEvent, runId: string): GatewayEvent[] {
  switch (event.type) {
    case "turn_started":
      return [{ type: "turn_started", runId }];
    case "model_event":
      return mapModelEvent(event.event);
    case "tool_calls_detected":
      return event.calls.map((call) => ({
        type: "tool_call_started",
        toolCallId: call.id,
        name: call.name,
        argsPreview: previewUnknown(call.input),
      }));
    case "tool_result":
      return [
        {
          type: "tool_call_finished",
          toolCallId: event.result.toolCallId,
          ok: event.result.type === "success",
          resultPreview: event.result.content.map(contentToText).join("\n"),
        },
      ];
    case "mode_change_requested":
      return [{ type: "plan_mode_changed", mode: event.mode }];
    case "turn_completed":
      return mapTurnCompleted(event.result);
    case "turn_failed":
      return [
        {
          type: "error",
          code: event.error.code,
          message: event.error.message,
          recoverable: false,
        },
      ];
    case "session_aborted":
      return [
        {
          type: "error",
          code: "agent_aborted",
          message: event.reason ?? "Session aborted.",
          recoverable: true,
        },
      ];
    default:
      return [];
  }
}

function mapModelEvent(event: CanonicalModelEvent): GatewayEvent[] {
  switch (event.type) {
    case "text_delta":
      return [{ type: "assistant_text_delta", text: event.text }];
    case "thinking_delta":
      return [{ type: "assistant_thinking_delta", text: event.text }];
    case "error":
      return [
        {
          type: "error",
          code: event.error.code,
          message: event.error.message,
          recoverable: true,
        },
      ];
    default:
      return [];
  }
}

function mapTurnCompleted(result: AgentTurnResult): GatewayEvent[] {
  const events: GatewayEvent[] = [];
  if (result.structuredOutput !== undefined) {
    events.push({ type: "structured_output", payload: result.structuredOutput });
  }
  events.push({ type: "turn_completed", usage: result.usage, finishReason: result.stopReason });
  return events;
}

function previewUnknown(value: unknown): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
