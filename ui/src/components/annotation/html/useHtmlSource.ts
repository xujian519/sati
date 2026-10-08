/**
 * HTML 标注的源读取（H2）：raw 字节 → SHA-256 → 源文本。
 *
 * - 字节来自 raw 文件端点（`api.readFileBlob`，不经 `?annotate=1` 的注入版本，也不经文本解码）；
 *   H0 #4 对拍：dsh `fileDigest` = 浏览器 `crypto.subtle` = 字节 SHA-256。
 * - 非安全上下文拿不到 `crypto.subtle`：`sha256` 为 null、`hashUnavailable` 为 true——
 *   **此时不得写侧车**（宁可不写，也不写一个会被 dsh 误判为过期的指纹）。
 * - 源文本供父页做 selector 的源解析校验（`validateSnapshotAgainstSource`）。
 */
import { useEffect, useState } from "react";
import { api } from "../../../utils/api";

/** 字节级 SHA-256（小写 hex）；无 `crypto.subtle` 时返回 null。 */
export async function computeByteSha256Hex(bytes: ArrayBuffer): Promise<string | null> {
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) return null;
  const digest = await subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** 源文本解码（UTF-8，替换字符容错；selector 校验只看结构，不受非 UTF-8 编码影响）。 */
export function decodeHtmlSourceText(bytes: ArrayBuffer): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

export type HtmlSourceState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; sourceText: string; sha256: string | null; hashUnavailable: boolean }
  | { status: "error"; message: string };

/**
 * 读取待标注 HTML 的源文件。
 *
 * @param projectName - 项目名；与 `filePath` 任一为空时保持 `idle`。
 * @param filePath - 目标文件路径（项目内相对或绝对均按既有编辑器约定）。
 * @returns 源文本、字节 SHA-256（或 null）与状态。
 */
export function useHtmlSource(
  projectName: string | null | undefined,
  filePath: string | null | undefined,
): HtmlSourceState {
  const [state, setState] = useState<HtmlSourceState>({ status: "idle" });

  useEffect(() => {
    if (!projectName || !filePath) {
      setState({ status: "idle" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    (async () => {
      const response = await api.readFileBlob(projectName, filePath);
      if (!response.ok) {
        throw new Error(`reading the HTML source failed with status ${response.status}`);
      }
      const bytes = await response.arrayBuffer();
      const sha256 = await computeByteSha256Hex(bytes);
      if (cancelled) return;
      setState({ status: "ready", sourceText: decodeHtmlSourceText(bytes), sha256, hashUnavailable: sha256 === null });
    })().catch((error: unknown) => {
      if (cancelled) return;
      setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
    });
    return () => {
      cancelled = true;
    };
  }, [projectName, filePath]);

  return state;
}
