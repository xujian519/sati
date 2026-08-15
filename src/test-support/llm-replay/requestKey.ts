/**
 * Stable request keying for the LLM replay seam (phase 4, T1).
 *
 * A request key is the sha256 of a canonical JSON projection of the request
 * (provider, model, system prompt, messages, tool schemas, tool choice, and
 * output cap). Metadata and provider `raw` payloads never influence the key,
 * and non-JSON values fail at record time instead of silently corrupting the
 * fixture.
 */
import { createHash } from "node:crypto";
import type { CanonicalModelRequest } from "../../model/index.js";
import { ReplayError } from "./types.js";

/**
 * JSON-stable serialization for keys and fixtures. Drops every `raw` key at
 * any depth (provider payloads are not JSON-safe), skips undefined fields,
 * and rejects function/symbol/bigint/circular values with a clear type error.
 *
 * @param value - the value to serialize; must be lossless JSON after raw stripping.
 * @returns the serialized JSON text.
 */
export function stableSerialize(value: unknown): string {
  try {
    // undefined values are skipped by JSON.stringify (absent fields), which is
    // exactly what the canonical projection wants for optional fields; real
    // circular structures are caught by JSON.stringify itself.
    const serialized = JSON.stringify(value, (key, item) => {
      if (key === "raw") return undefined;
      if (item === undefined) return undefined;
      if (typeof item === "function" || typeof item === "symbol" || typeof item === "bigint") {
        throw new TypeError("cannot serialize a non-JSON value of type " + typeof item);
      }
      return item;
    });
    if (serialized === undefined) {
      throw new TypeError("serialization produced no value");
    }
    return serialized;
  } catch (error) {
    throw new TypeError("cannot serialize: " + (error instanceof Error ? error.message : String(error)));
  }
}

/**
 * Stable content key for one model request. Two requests replay from the same
 * record only when provider/model/system prompt/messages/tool schemas/tool
 * choice/output cap agree.
 *
 * @param request - the request to key; unchanged by this call.
 * @returns the sha256 hex digest of the canonical projection.
 */
export function replayRequestKey(request: CanonicalModelRequest): string {
  const payload = {
    provider: request.provider,
    model: request.model,
    systemPrompt: request.systemPrompt,
    messages: request.messages,
    tools: request.tools?.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema })),
    toolChoice: request.toolChoice,
    maxOutputTokens: request.maxOutputTokens,
    outputSchema: request.outputSchema,
  };
  try {
    return createHash("sha256").update(stableSerialize(payload)).digest("hex");
  } catch (error) {
    throw new ReplayError(
      "FIXTURE_INVALID",
      "request cannot be keyed for replay: " + (error instanceof Error ? error.message : String(error)),
      { cause: error },
    );
  }
}

/**
 * Human-readable request summary for manifests and failure messages.
 *
 * @param request - the request to summarize; unchanged by this call.
 * @returns tool names plus truncated user-role text blocks.
 */
export function requestSummary(request: CanonicalModelRequest): { toolNames: string[]; userTexts: string[] } {
  const toolNames = (request.tools ?? []).map(tool => tool.name);
  const userTexts: string[] = [];
  for (const message of request.messages) {
    if (message.role !== "user") continue;
    const parts: string[] = [];
    for (const block of message.content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length > 0) {
      const joined = parts.join(" ");
      userTexts.push(joined.length > 120 ? joined.slice(0, 120) + "…" : joined);
    }
  }
  return { toolNames, userTexts };
}
