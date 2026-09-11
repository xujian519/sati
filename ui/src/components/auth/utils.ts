import type { ApiErrorPayload } from "./types";

export async function parseJsonSafely<T>(response: Response): Promise<T | null> {
  try {
    return (await response.json()) as T;
  } catch {
    // 响应体非 JSON → 返回 null（调用方用 fallback 文案）。
    return null;
  }
}

export function resolveApiErrorMessage(payload: ApiErrorPayload | null, fallback: string): string {
  if (!payload) {
    return fallback;
  }

  return payload.error ?? payload.message ?? fallback;
}
