// llm-extraction 的 HTTP 请求构造与执行（从 llm-extraction.ts 拆出，行为等价）。
// provider 适配（api 归一/temperature 省略/Google URL 构造）+ 4 分支请求体构造
// + 带重试的 POST 执行。全部无 this 依赖，可独立单测。
import {
  DEFAULT_REQUEST_MAX_ATTEMPTS,
  REQUEST_RETRYABLE_STATUS_CODES,
  computeRetryDelayMs,
  isTransientRequestError,
  resolveRequestTimeoutMs,
  sleep,
} from "./request-retry.js";
import { stripTrailingSlash, truncate } from "./llm-normalizers.js";

function normalizeProviderApi(value: string): string {
  const api = value.trim().toLowerCase();
  return api === "gemini" ? "google" : api;
}

/**
 * 推理模型（deepseek-v4 系列/deepseek-reasoner/kimi-k2 系列/kimi-k3 等）
 * 官方约束 temperature 不可修改（kimi 传其他值报错、deepseek-v4 思考模式
 * 静默忽略）。直连构造 body 时须省略显式 temperature。
 */
function shouldOmitTemperature(model: string): boolean {
  return /deepseek-v4|deepseek-reasoner|deepseek-r1|kimi-k2|kimi-k3/.test(model.toLowerCase());
}

function buildGoogleGenerateContentUrl(baseUrl: string, model: string): string {
  const url = new URL(stripTrailingSlash(baseUrl));
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  const apiVersion = last === "v1" || last === "v1beta" ? last : "v1beta";
  const baseParts = last === "v1" || last === "v1beta" ? parts.slice(0, -1) : parts;
  url.pathname = `/${[
    ...baseParts,
    apiVersion,
    "models",
    `${encodeURIComponent(normalizeGoogleModelId(model))}:generateContent`,
  ].join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeGoogleModelId(model: string): string {
  const withoutProvider = model.trim().startsWith("google/") ? model.trim().slice("google/".length) : model.trim();
  if (withoutProvider === "gemini-3-pro") return "gemini-3-pro-preview";
  if (withoutProvider === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
  if (withoutProvider === "gemini-3-flash") return "gemini-3-flash-preview";
  if (withoutProvider === "gemini-3.1-flash" || withoutProvider === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (withoutProvider === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
  return withoutProvider;
}

function looksLikeEnvVarName(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value);
}

export interface ProviderRequestSelection {
  provider: string;
  model: string;
  api: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export function buildProviderRequest(input: {
  apiType: string;
  selection: ProviderRequestSelection;
  systemPrompt: string;
  userPrompt: string;
  apiKey: string;
}): { url: string; body: Record<string, unknown>; headers: Headers } {
  const { apiType, selection, systemPrompt, userPrompt, apiKey } = input;
  const baseUrl = selection.baseUrl;
  if (!baseUrl) {
    throw new Error("Provider request requires a baseUrl");
  }
  const headers = new Headers(selection.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  let url = "";
  let body: Record<string, unknown>;

  if (apiType === "openai-responses" || apiType === "responses") {
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
    url = `${baseUrl}/responses`;
    body = {
      model: selection.model,
      temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
      input: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
  } else if (apiType === "anthropic") {
    if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
    if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
    url = `${selection.baseUrl}/v1/messages`;
    body = {
      model: selection.model,
      max_tokens: 65536,
      temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    };
  } else if (apiType === "google") {
    if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
    url = buildGoogleGenerateContentUrl(baseUrl, selection.model);
    body = {
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      generationConfig: {
        temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
        responseMimeType: "application/json",
      },
    };
  } else {
    if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
    url = `${selection.baseUrl}/chat/completions`;
    body = {
      model: selection.model,
      temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
      stream: false,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
  }
  return { url, body, headers };
}

export async function executeWithRetryRequest(input: {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  requestLabel: string;
  timeoutMs?: number;
}): Promise<Response> {
  const { url, headers, body, requestLabel, timeoutMs } = input;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < DEFAULT_REQUEST_MAX_ATTEMPTS; attempt += 1) {
    try {
      const controller = new AbortController();
      const resolvedTimeoutMs = resolveRequestTimeoutMs(timeoutMs);
      const timeoutId = resolvedTimeoutMs === null ? null : setTimeout(() => controller.abort(), resolvedTimeoutMs);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (resolvedTimeoutMs !== null && error instanceof Error && error.name === "AbortError") {
          throw new Error(`${requestLabel} request timed out after ${resolvedTimeoutMs}ms`);
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
      if (response.ok) return response;
      const errorText = await response.text();
      const error = Object.assign(
        new Error(`${requestLabel} request failed (${response.status}): ${truncate(errorText, 300)}`),
        { status: response.status },
      );
      lastError = error;
      if (!REQUEST_RETRYABLE_STATUS_CODES.has(response.status) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
        throw error;
      }
    } catch (error) {
      lastError = error;
      if (!isTransientRequestError(error) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
        throw error;
      }
    }
    await sleep(computeRetryDelayMs(attempt));
  }
  throw lastError instanceof Error ? lastError : new Error(`${requestLabel} request failed`);
}

export {
  buildGoogleGenerateContentUrl,
  looksLikeEnvVarName,
  normalizeGoogleModelId,
  normalizeProviderApi,
  shouldOmitTemperature,
};
