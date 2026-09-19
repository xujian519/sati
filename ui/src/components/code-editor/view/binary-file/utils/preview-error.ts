export async function readPreviewErrorResponse(res: Response) {
  let detail = "";
  let code = "";
  try {
    const body = await res.json();
    detail = body?.error || body?.code || "";
    code = body?.code || "";
  } catch {
    // Error body was not JSON — fall back to the raw response text ("" if unreadable).
    detail = await res.text().catch(() => "");
  }
  const error = new Error(detail || `HTTP ${res.status}`) as Error & { code?: string };
  error.code = code;
  return error;
}
