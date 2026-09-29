/**
 * 工作区文件上传的结果归纳。
 *
 * 后端拒绝覆盖同名文件时返回 207（部分写入）或 409（全部被拒），并附
 * `conflicts` / `files` / `errors`。207 落在 `Response.ok` 区间内，只看
 * `ok` 会把失败当成功吞掉，因此这里一律按载荷判定，并把被拒文件提示给用户。
 */

type TranslateFunction = (key: string, options?: Record<string, unknown>) => string;

/** 归纳只依赖响应的这三项，故按最小契约声明，便于测试直接构造。 */
export type UploadHttpResponse = Pick<Response, "ok" | "status" | "json">;

type UploadPayload = {
  conflicts?: unknown;
  error?: unknown;
};

function readConflicts(payload: UploadPayload | null): string[] {
  return Array.isArray(payload?.conflicts) ? payload.conflicts.filter(name => typeof name === "string") : [];
}

function readErrorMessage(payload: UploadPayload | null, status: number): string {
  const failure = payload?.error;
  if (typeof failure === "string" && failure) return failure;
  if (failure && typeof failure === "object" && "message" in failure && typeof failure.message === "string") {
    return failure.message;
  }
  return `Upload failed: ${status}`;
}

/**
 * 归纳一次上传响应：把被拒的同名文件提示给用户，其余失败照旧抛出，
 * 成功或部分成功时刷新文件树。
 */
export async function applyWorkspaceUploadOutcome(
  response: UploadHttpResponse,
  options: { refresh: () => void | Promise<void>; translate: TranslateFunction },
): Promise<void> {
  const payload = (await response.json().catch(() => null)) as UploadPayload | null;
  const conflicts = readConflicts(payload);
  if (conflicts.length > 0) {
    // 部分文件可能已经落盘，先刷新再报告未上传的那部分。
    await options.refresh();
    window.dispatchEvent(
      new CustomEvent("sati:toast", {
        detail: {
          kind: "error",
          message: options.translate("fileTree.uploadConflict", { names: conflicts.join(", ") }),
        },
      }),
    );
    return;
  }
  if (!response.ok) {
    throw new Error(readErrorMessage(payload, response.status));
  }
  await options.refresh();
}
