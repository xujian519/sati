export type ProviderEndpointProtocol = "openai" | "openai-responses" | "anthropic" | "google";

const VERSION_SEGMENT_PATTERN = /^v\d+(?:beta\d*)?$/i;

function trimSlashes(value: string): string {
  return value.replace(/^\/+|\/+$/g, "");
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

function getPathSegments(baseUrl: string): string[] {
  try {
    return new URL(baseUrl).pathname.split("/").filter(Boolean);
  } catch {
    return [];
  }
}

function hasVersionSegment(baseUrl: string): boolean {
  return getPathSegments(baseUrl).some((segment) => VERSION_SEGMENT_PATTERN.test(segment));
}

function pathEndsWith(baseUrl: string, suffix: string[]): boolean {
  const segments = getPathSegments(baseUrl).map((segment) => segment.toLowerCase());
  const normalizedSuffix = suffix.map((segment) => segment.toLowerCase());
  if (segments.length < normalizedSuffix.length) return false;
  return normalizedSuffix.every((segment, index) => segments[segments.length - normalizedSuffix.length + index] === segment);
}

function buildVersionedEndpoint(baseUrl: string, defaultVersion: string, endpointPath: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  const normalizedEndpointPath = trimSlashes(endpointPath);
  const endpointSegments = normalizedEndpointPath.split("/").filter(Boolean);
  if (pathEndsWith(normalizedBase, endpointSegments)) return normalizedBase;
  const prefix = hasVersionSegment(normalizedBase) ? "" : defaultVersion;
  return joinUrl(normalizedBase, [prefix, normalizedEndpointPath].filter(Boolean).join("/"));
}

export function normalizeGoogleProbeModel(model: string): string {
  const text = String(model || "").trim();
  const withoutProvider = text.startsWith("google/") ? text.slice("google/".length) : text;
  if (withoutProvider === "gemini-3-pro") return "gemini-3-pro-preview";
  if (withoutProvider === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
  if (withoutProvider === "gemini-3-flash") return "gemini-3-flash-preview";
  if (withoutProvider === "gemini-3.1-flash" || withoutProvider === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (withoutProvider === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
  return withoutProvider;
}

export function buildProviderChatEndpoint(input: {
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
  model?: string;
  googleMethod?: string;
}): string {
  const normalizedProtocol = input.protocol;
  if (normalizedProtocol === "anthropic") {
    return buildVersionedEndpoint(input.baseUrl, "v1", "messages");
  }
  if (normalizedProtocol === "openai-responses") {
    return buildVersionedEndpoint(input.baseUrl, "v1", "responses");
  }
  if (normalizedProtocol === "google") {
    const method = input.googleMethod || "generateContent";
    const model = encodeURIComponent(normalizeGoogleProbeModel(input.model || ""));
    const normalizedBase = input.baseUrl.trim().replace(/\/+$/, "") || "https://generativelanguage.googleapis.com";
    return buildVersionedEndpoint(normalizedBase, "v1beta", `models/${model}:${method}`);
  }
  return buildVersionedEndpoint(input.baseUrl, "v1", "chat/completions");
}

export function buildProviderModelsEndpoint(input: {
  protocol: ProviderEndpointProtocol;
  baseUrl: string;
}): string {
  if (input.protocol === "google") {
    return buildVersionedEndpoint(input.baseUrl, "v1beta", "models");
  }
  return buildVersionedEndpoint(input.baseUrl, "v1", "models");
}
