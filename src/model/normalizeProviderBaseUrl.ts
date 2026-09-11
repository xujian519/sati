/**
 * Normalize provider API base URL for telemetry (no credentials, query, or fragment).
 */
export function normalizeProviderBaseUrl(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return undefined;
    }
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    let normalized = parsed.toString();
    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }
    return normalized;
  } catch {
    // 非合法 http(s) URL → 返回 undefined（调用方视为无 base URL）。
    return undefined;
  }
}
