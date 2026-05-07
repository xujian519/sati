import { normalizeModelError } from "../errors/normalizeModelError.js";
import { buildModelRequest } from "../request/buildModelRequest.js";
import { validateModelRequest } from "../request/validateModelRequest.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  ModelConfig,
  ModelProtocol,
  ProviderConfig,
} from "../protocol/canonical.js";
import { ModelProviderError } from "../protocol/errors.js";
import { parseModelResponse } from "../response/parseModelResponse.js";
import { createStreamNormalizerState, normalizeStreamEvent } from "./normalizeStreamEvent.js";

export type ModelTransport = typeof fetch;

export type ModelRuntimeOptions = {
  fetch?: ModelTransport;
  signal?: AbortSignal;
};

export async function complete(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
) {
  const nonStreamingRequest = { ...request, stream: false };
  const { provider } = validateModelRequest(nonStreamingRequest, config);
  const body = buildModelRequest(nonStreamingRequest, config);
  const response = await sendProviderRequest(provider, body, false, options.fetch ?? fetch, options.signal);
  const raw = await response.json();

  if (!response.ok) {
    throw new ModelProviderError(
      normalizeModelError(provider.id, provider.protocol, raw, response.status),
    );
  }

  return parseModelResponse(provider.protocol, raw, provider.id);
}

export async function* streamModel(
  request: CanonicalModelRequest,
  config: ModelConfig,
  options: ModelRuntimeOptions = {},
): AsyncIterable<CanonicalModelEvent> {
  const streamingRequest = { ...request, stream: true };
  const { provider } = validateModelRequest(streamingRequest, config);
  const body = buildModelRequest(streamingRequest, config);

  yield {
    type: "request_started",
    provider: provider.id,
    model: streamingRequest.model,
    metadata: streamingRequest.metadata,
  };

  const response = await sendProviderRequest(provider, body, true, options.fetch ?? fetch, options.signal);
  if (!response.ok) {
    const raw = await safeReadJson(response);
    yield {
      type: "error",
      error: normalizeModelError(provider.id, provider.protocol, raw, response.status),
    };
    return;
  }

  if (!response.body) {
    yield {
      type: "error",
      error: normalizeModelError(provider.id, provider.protocol, new Error("Missing response body.")),
    };
    return;
  }

  const state = createStreamNormalizerState();
  for await (const rawEvent of readServerSentEvents(response.body)) {
    for (const event of normalizeStreamEvent(provider.protocol, rawEvent, state)) {
      yield event;
    }
  }
}

async function sendProviderRequest(
  provider: ProviderConfig,
  body: unknown,
  stream: boolean,
  transport: ModelTransport,
  signal?: AbortSignal,
): Promise<Response> {
  const controller = new AbortController();
  const detachAbort = signal ? forwardAbort(signal, controller) : undefined;
  const timeout = provider.timeoutMs
    ? setTimeout(() => controller.abort(), provider.timeoutMs)
    : undefined;

  try {
    return await transport(buildEndpoint(provider, stream), {
      method: "POST",
      headers: buildHeaders(provider),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (error) {
    throw new ModelProviderError(normalizeModelError(provider.id, provider.protocol, error));
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    detachAbort?.();
  }
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
  if (source.aborted) {
    target.abort(source.reason);
    return () => {};
  }

  const onAbort = () => target.abort(source.reason);
  source.addEventListener("abort", onAbort, { once: true });
  return () => source.removeEventListener("abort", onAbort);
}

function buildEndpoint(provider: ProviderConfig, _stream: boolean): string {
  if (provider.protocol === "anthropic") {
    return joinUrl(provider.url, "v1/messages");
  }

  return joinUrl(provider.url, "chat/completions");
}

function buildHeaders(provider: ProviderConfig): HeadersInit {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    ...provider.headers,
  };

  if (provider.protocol === "anthropic") {
    headers["x-api-key"] = provider.apiKey;
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
  } else {
    headers.authorization = headers.authorization ?? `Bearer ${provider.apiKey}`;
  }

  return headers;
}

async function safeReadJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return await response.text();
  }
}

async function* readServerSentEvents(body: ReadableStream<Uint8Array>): AsyncIterable<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      buffer += decoder.decode();
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split(/\n\n/);
    buffer = chunks.pop() ?? "";

    for (const chunk of chunks) {
      const dataLines = chunk
        .split(/\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trim());

      for (const data of dataLines) {
        if (!data || data === "[DONE]") {
          continue;
        }
        yield JSON.parse(data);
      }
    }
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}
