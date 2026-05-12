import type { Gateway, GatewayEvent } from "../../src/gateway/protocol/types.js";
import type { CanonicalUsage } from "../../src/model/protocol/canonical.js";

export type ExecutionResult = {
  taskId: string;
  sessionKey: string;
  status: "success" | "timeout" | "error";
  events: GatewayEvent[];
  usage: CanonicalUsage;
  /** Concatenated assistant text deltas. */
  assistantText: string;
  /** Tool calls observed during the turn: name + ok status. */
  toolCalls: Array<{ name: string; ok: boolean }>;
  executionTimeMs: number;
  error?: string;
};

/**
 * Execute a single PinchBench task against a PilotDeck Gateway.
 *
 * Creates a new session, sends the task prompt via `submitTurn`, collects all
 * events, then closes the session. Handles timeout via AbortController.
 */
export async function executeTask(
  gateway: Gateway,
  opts: {
    taskId: string;
    prompt: string;
    timeoutMs: number;
    projectKey?: string;
  },
): Promise<ExecutionResult> {
  const { sessionKey } = await gateway.newSession({
    channelKey: "test",
    projectKey: opts.projectKey,
  });

  const events: GatewayEvent[] = [];
  const textParts: string[] = [];
  const pendingTools = new Map<string, string>();
  const toolCalls: ExecutionResult["toolCalls"] = [];
  let usage: CanonicalUsage = {};
  let status: ExecutionResult["status"] = "success";
  let error: string | undefined;

  const start = performance.now();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    gateway.abortTurn({ sessionKey }).catch(() => {});
  }, opts.timeoutMs);

  try {
    for await (const event of gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      message: opts.prompt,
      mode: "bypassPermissions",
    })) {
      events.push(event);
      switch (event.type) {
        case "assistant_text_delta":
          textParts.push(event.text);
          break;
        case "tool_call_started":
          pendingTools.set(event.toolCallId, event.name);
          break;
        case "tool_call_finished": {
          const name = pendingTools.get(event.toolCallId) ?? "unknown";
          toolCalls.push({ name, ok: event.ok });
          pendingTools.delete(event.toolCallId);
          break;
        }
        case "turn_completed":
          usage = event.usage;
          break;
        case "error":
          if (!event.recoverable) {
            status = "error";
            error = event.message;
          }
          break;
      }
    }
  } catch (err) {
    status = "error";
    error = err instanceof Error ? err.message : String(err);
  } finally {
    clearTimeout(timer);
    await gateway.closeSession({ sessionKey, reason: "benchmark_done" }).catch(() => {});
  }

  if (timedOut) status = "timeout";

  return {
    taskId: opts.taskId,
    sessionKey,
    status,
    events,
    usage,
    assistantText: textParts.join(""),
    toolCalls,
    executionTimeMs: performance.now() - start,
    error,
  };
}
