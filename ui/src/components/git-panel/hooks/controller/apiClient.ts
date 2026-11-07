import { authenticatedFetch } from "../../../../utils/api";

// ! use authenticatedFetch directly. fetchWithAuth is redundant
export const fetchWithAuth = authenticatedFetch as (url: string, options?: RequestInit) => Promise<Response>;

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export async function readJson<T>(response: Response, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  const data = (await response.json()) as T;

  if (signal?.aborted) {
    throw new DOMException("Request aborted", "AbortError");
  }

  return data;
}
