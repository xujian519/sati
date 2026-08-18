import { buildAnthropicRequest, type AnthropicRequestBody } from "../providers/anthropic/request.js";
import { buildGoogleRequest, type GoogleRequestBody } from "../providers/google/request.js";
import { buildOpenAIRequest, type OpenAIRequestBody } from "../providers/openai/request.js";
import { buildOpenAIResponsesRequest, type OpenAIResponsesRequestBody } from "../providers/openai-responses/request.js";
import type { CanonicalModelRequest, ModelConfig } from "../protocol/canonical.js";
import { validateModelRequest } from "./validateModelRequest.js";

export type ProviderRequestBody =
  | AnthropicRequestBody
  | GoogleRequestBody
  | OpenAIRequestBody
  | OpenAIResponsesRequestBody;

/**
 * 能力门控（2026-08 修复）：模型不支持 structured output（supportsJsonSchema=false）
 * 时剥离 request.outputSchema，由调用方 prompt 内嵌 JSON 要求 + 解析兜底。
 *
 * 背景：deepseek 的 openai 兼容 API 实测拒绝 response_format=json_schema
 * （"This response_format type is unavailable now"），而 catalog 曾标
 * supportsJsonSchema=true——导致 patent_workflow_run 工具内部全部带 schema 的
 * 原子调用失败降级。门控后能力解析成为唯一真相。
 */
function gateOutputSchemaByCapability(
  request: CanonicalModelRequest,
  model: { capabilities: { supportsJsonSchema?: boolean } },
): CanonicalModelRequest {
  if (request.outputSchema === undefined || model.capabilities.supportsJsonSchema !== false) {
    return request;
  }
  return { ...request, outputSchema: undefined };
}

export function buildModelRequest(request: CanonicalModelRequest, config: ModelConfig): ProviderRequestBody {
  const { provider, model } = validateModelRequest(request, config);
  const effective = gateOutputSchemaByCapability(request, model);

  if (provider.protocol === "anthropic") {
    return buildAnthropicRequest(effective, model);
  }

  if (provider.protocol === "google") {
    return buildGoogleRequest(effective, model);
  }

  if (provider.protocol === "openai-responses") {
    return buildOpenAIResponsesRequest(effective, model, provider);
  }

  return buildOpenAIRequest(effective, model, provider);
}
