/**
 * `GatewayElicitationChannel` — bridge between a tool's `askUser()` call and
 * the Gateway's downstream event stream.
 *
 * Flow:
 *   1. `ask_user_question.execute(...)` calls `context.elicitation.askUser`.
 *   2. This channel:
 *        - generates a `requestId`
 *        - registers `(resolve, reject)` in the per-session
 *          `GatewayElicitationBus`
 *        - emits an `elicitation_request` event into the active gateway
 *          stream via `emit(...)`
 *        - awaits the host's `respondElicitation({ requestId, answer })`
 *          which the bus resolves
 *   3. AbortSignal from the request is honored — on abort the entry is
 *      consumed-and-rejected and an `elicitation_cancelled` event is
 *      emitted to clean up the host UI.
 *
 * Behaviour parity with `third-party/claude-code-main/src/services/sdk/elicitationHandler.ts`:
 *   - Single round-trip per `askUser` invocation (E1).
 *   - User can decline → returns `{ type: "cancelled", reason }` (E2).
 *   - Free-form per-question annotations carried verbatim (E3).
 *   - Multi-select answers preserved as `Array<string>` (E4).
 */

import { randomUUID } from "node:crypto";
import type {
  PolitDeckElicitationAnswer,
  PolitDeckElicitationChannel,
  PolitDeckElicitationRequest,
} from "../../tool/elicitation/PolitDeckElicitationChannel.js";
import type { GatewayElicitationBus } from "./GatewayElicitationBus.js";
import type { GatewayEvent } from "../protocol/types.js";

export type GatewayElicitationChannelOptions = {
  sessionKey: string;
  bus: GatewayElicitationBus;
  /**
   * Push a `GatewayEvent` into the active turn's downstream stream. The
   * gateway implementation owns the wiring (queue / fan-in) and just hands
   * us this thin sink.
   */
  emit(event: GatewayEvent): void;
  /** Optional UUID generator (test override). Defaults to `crypto.randomUUID`. */
  uuid?: () => string;
};

export class GatewayElicitationChannel implements PolitDeckElicitationChannel {
  private readonly uuid: () => string;

  constructor(private readonly options: GatewayElicitationChannelOptions) {
    this.uuid = options.uuid ?? randomUUID;
  }

  askUser(request: PolitDeckElicitationRequest): Promise<PolitDeckElicitationAnswer> {
    const requestId = this.uuid();
    const { bus, emit, sessionKey } = this.options;

    return new Promise<PolitDeckElicitationAnswer>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;

      const pending = {
        requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        resolve: (answer: PolitDeckElicitationAnswer) => {
          if (abortHandler && request.signal) {
            request.signal.removeEventListener("abort", abortHandler);
          }
          resolve(answer);
        },
        reject: (error: Error) => {
          if (abortHandler && request.signal) {
            request.signal.removeEventListener("abort", abortHandler);
          }
          reject(error);
        },
      };

      bus.register(sessionKey, pending);

      // Surface the request downstream so the host (TUI / CLI / Feishu)
      // can render the dialog. The `payload` mirrors the legacy elicitation
      // schema so existing UIs already understand it.
      emit({
        type: "elicitation_request",
        requestId,
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        previewFormat: request.previewFormat,
        questions: request.questions,
        metadata: request.metadata,
      });

      if (request.signal) {
        if (request.signal.aborted) {
          // Already-aborted: synthesize a cancelled answer immediately.
          const consumed = bus.consume(sessionKey, requestId);
          consumed?.resolve({ type: "cancelled", reason: "aborted" });
          emit({ type: "elicitation_cancelled", requestId, reason: "aborted" });
          return;
        }
        abortHandler = () => {
          const consumed = bus.consume(sessionKey, requestId);
          consumed?.resolve({ type: "cancelled", reason: "aborted" });
          emit({ type: "elicitation_cancelled", requestId, reason: "aborted" });
        };
        request.signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }
}
