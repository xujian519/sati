import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentInput, AgentTurnResult } from "../../agent/index.js";
import type { CanonicalContentBlock, CanonicalModelEvent } from "../../model/index.js";
import { contentToText } from "../../tool/index.js";
import type { SessionRouter } from "../SessionRouter.js";
import { GatewayElicitationBus } from "../elicitation/GatewayElicitationBus.js";
import { GatewayPermissionBus } from "../permission/GatewayPermissionBus.js";
import { AsyncQueue } from "../util/AsyncQueue.js";
import type {
  ChannelAttachment,
  GatewayCronController,
  Gateway,
  GatewayElicitationResponseInput,
  GatewayEvent,
  GatewayPermissionDecisionInput,
  GatewayServerInfo,
  GatewaySubmitTurnInput,
  ListSessionsInput,
  ListSessionsResult,
  NewSessionInput,
  ReloadConfigResult,
  WebDescribeProjectInput,
  WebListProjectsResult,
  WebProjectSummary,
  WebReadSessionMessagesInput,
  WebReadSessionMessagesResult,
} from "../protocol/types.js";
import type {
  CronCreateInput,
  CronCreateResult,
  CronDeleteInput,
  CronDeleteResult,
  CronListInput,
  CronListResult,
  CronStopInput,
  CronStopResult,
} from "../../cron/protocol/types.js";

export type InProcessGatewayOptions = {
  now?: () => Date;
  uuid?: () => string;
  serverInfo?: Partial<GatewayServerInfo>;
  cron?: GatewayCronController;
  /**
   * Web Phase 2 — pluggable session-history reader. Wired by
   * `createLocalGateway` so the in-process gateway can answer
   * `read_session_messages` without leaking transcript paths.
   */
  readSessionMessages?: (input: WebReadSessionMessagesInput) => Promise<WebReadSessionMessagesResult>;
  /**
   * Web Phase 3 — pluggable project enumerator + describer.
   */
  listProjects?: () => Promise<WebListProjectsResult>;
  describeProject?: (input: WebDescribeProjectInput) => Promise<WebProjectSummary>;
  /**
   * Pluggable config-reload handler wired by `createLocalGateway`.
   * When set, `reloadConfig()` delegates to this callback which owns
   * the PilotConfigStore + ProjectRuntimeRegistry lifecycle.
   */
  reloadConfig?: () => Promise<ReloadConfigResult>;
};

export class InProcessGateway implements Gateway {
  private readonly now: () => Date;
  private readonly uuid: () => string;
  /**
   * B1 — registry of active per-session emit sinks. The gateway shares this
   * map with the per-session `GatewayElicitationChannel` so an `askUser`
   * call can surface an `elicitation_request` event into the active
   * `submitTurn` stream from outside the agent's event iterator.
   */
  private readonly emitSinks = new Map<string, (event: GatewayEvent) => void>();
  /** B1 — pending askUser() promises keyed by sessionKey + requestId. */
  private readonly elicitationBus = new GatewayElicitationBus();
  /**
   * Web Phase 2 — pending permission-decision promises. Tools that need
   * Web confirmation register here while the host UI shows the banner.
   */
  private readonly permissionBus = new GatewayPermissionBus();

  constructor(
    private readonly router: SessionRouter,
    private readonly options: InProcessGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  /**
   * B1 — exposed so per-session bridge channels can find the bus / emit
   * sink without going through `respondElicitation`. Caller MUST already
   * hold a sessionKey.
   */
  getElicitationBus(): GatewayElicitationBus {
    return this.elicitationBus;
  }

  /**
   * Web Phase 2 — exposed so per-session bridge channels (or tests) can
   * register pending permission decisions and emit `permission_request`
   * events.
   */
  getPermissionBus(): GatewayPermissionBus {
    return this.permissionBus;
  }

  /**
   * Push a synthesized {@link GatewayEvent} into the active `submitTurn`
   * stream for the given session. Returns true when a sink existed and
   * the event was queued, false otherwise (e.g. no turn currently in
   * progress for that session).
   *
   * Used by per-session bridge hooks (notably the interactive
   * permission hook) that need to surface UI prompts mid-turn without
   * waiting for the agent's own event loop to emit them.
   */
  emitForSession(sessionKey: string, event: GatewayEvent): boolean {
    const sink = this.emitSinks.get(sessionKey);
    if (!sink) return false;
    sink(event);
    return true;
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

    const queue = new AsyncQueue<GatewayEvent>();
    this.emitSinks.set(input.sessionKey, (event) => queue.enqueue(event));

    // Background pump: agent events → queue.
    const pump = (async () => {
      try {
        const session = await this.router.getOrCreate({
          sessionKey: input.sessionKey,
          projectKey: input.projectKey,
          channelKey: input.channelKey,
        });
        // Promote a text-only turn to a multimodal blocks turn when the
        // host channel attached files/images. Without this the
        // GatewaySubmitTurnInput.attachments field was effectively dead —
        // the bridge could forward UI uploads but the agent never saw
        // them. Only `image` attachments map to a canonical block today;
        // file/pdf/audio attachments would need their own block builders
        // (or a tool round-trip) so they fall through and the user gets
        // a text-only turn rather than a corrupted multipart.
        const agentInput = buildAgentInputWithAttachments(
          input.message,
          input.attachments,
        );
        for await (const event of session.submit(agentInput, { turnId: runId })) {
          for (const gatewayEvent of mapAgentEvent(event, runId)) {
            queue.enqueue(gatewayEvent);
          }
        }
      } catch (error) {
        queue.enqueue({
          type: "error",
          code: "gateway_submit_failed",
          message: error instanceof Error ? error.message : String(error),
          recoverable: false,
        });
      } finally {
        queue.close();
      }
    })();

    try {
      for await (const event of queue) {
        yield event;
      }
    } finally {
      // Clean up the emit-sink and any orphaned elicitation / permission
      // entries before returning so a subsequent turn doesn't see stale
      // state.
      this.emitSinks.delete(input.sessionKey);
      this.elicitationBus.rejectSession(input.sessionKey, "turn_ended");
      this.permissionBus.rejectSession(input.sessionKey, "turn_ended");
      this.router.endTurn(input.sessionKey, runId);
      // Defensive — make sure the pump promise is settled before we resolve.
      await pump.catch(() => undefined);
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

  async cronCreate(input: CronCreateInput): Promise<CronCreateResult> {
    return this.requireCron().createTask(input);
  }

  async cronList(input: CronListInput): Promise<CronListResult> {
    return this.requireCron().listTasks(input);
  }

  async cronDelete(input: CronDeleteInput): Promise<CronDeleteResult> {
    return this.requireCron().deleteTask(input);
  }

  async cronStop(input: CronStopInput): Promise<CronStopResult> {
    return this.requireCron().stopTask(input);
  }

  async respondElicitation(input: GatewayElicitationResponseInput): Promise<{ delivered: boolean }> {
    const entry = this.elicitationBus.consume(input.sessionKey, input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve(input.answer);
    return { delivered: true };
  }

  async permissionDecide(input: GatewayPermissionDecisionInput): Promise<{ delivered: boolean }> {
    const entry = this.permissionBus.consume(input.sessionKey, input.requestId);
    if (!entry) return { delivered: false };
    entry.resolve({
      requestId: input.requestId,
      decision: input.decision,
      remember: input.remember,
      reason: input.reason,
    });
    return { delivered: true };
  }

  async readSessionMessages(input: WebReadSessionMessagesInput): Promise<WebReadSessionMessagesResult> {
    if (!this.options.readSessionMessages) {
      throw new Error(
        "read_session_messages is not configured. Wire `readSessionMessages` via createLocalGateway.",
      );
    }
    return this.options.readSessionMessages(input);
  }

  async listProjects(): Promise<WebListProjectsResult> {
    if (!this.options.listProjects) {
      throw new Error("list_projects is not configured.");
    }
    return this.options.listProjects();
  }

  async describeProject(input: WebDescribeProjectInput): Promise<WebProjectSummary> {
    if (!this.options.describeProject) {
      throw new Error("describe_project is not configured.");
    }
    return this.options.describeProject(input);
  }

  async reloadConfig(): Promise<ReloadConfigResult> {
    if (!this.options.reloadConfig) {
      return { reloaded: false };
    }
    return this.options.reloadConfig();
  }

  private requireCron(): GatewayCronController {
    if (!this.options.cron) {
      throw new Error("Cron runtime is not configured.");
    }
    return this.options.cron;
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
          ...(event.result.type === "error" && { errorCode: event.result.error.code }),
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

/**
 * Build an `AgentInput` from the user's text plus any host-provided
 * channel attachments. Returns a plain text input when no attachments
 * are useful (the agent loop fast-paths text and writes a cleaner
 * transcript entry), and a `blocks` input when at least one image is
 * present so the model receives the multimodal payload.
 *
 * Today only `image` attachments map to a canonical block. Non-image
 * attachments are dropped here (with no error event — callers that
 * need richer surface should add their own block builders or use a
 * tool round-trip), so the user still gets a text-only turn rather
 * than a corrupted multipart.
 */
function buildAgentInputWithAttachments(
  message: string,
  attachments: ChannelAttachment[] | undefined,
): AgentInput {
  const imageBlocks = attachmentsToImageBlocks(attachments);
  if (imageBlocks.length === 0) {
    return { type: "text", text: message };
  }
  const blocks: CanonicalContentBlock[] = [];
  if (message && message.length > 0) {
    blocks.push({ type: "text", text: message });
  }
  for (const block of imageBlocks) {
    blocks.push(block);
  }
  return { type: "blocks", content: blocks };
}

function attachmentsToImageBlocks(
  attachments: ChannelAttachment[] | undefined,
): CanonicalContentBlock[] {
  if (!attachments || attachments.length === 0) return [];
  const blocks: CanonicalContentBlock[] = [];
  for (const att of attachments) {
    if (att.type !== "image") continue;
    if (!att.content || !att.mimeType) continue;
    blocks.push({
      type: "image",
      source: "base64",
      data: att.content,
      mimeType: att.mimeType,
      ...(typeof att.bytes === "number" ? { bytes: att.bytes } : {}),
    });
  }
  return blocks;
}
