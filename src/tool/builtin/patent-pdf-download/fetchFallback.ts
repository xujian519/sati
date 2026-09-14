import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { networkFetch } from "../../../network/index.js";
import type { PatentDownloadItem, ScriptDownloadItem } from "./types.js";

/**
 * Google Patents CDN（patentimages.storage.googleapis.com）对非浏览器 UA 会返回 403，
 * 因此这里刻意用浏览器 UA——不能复用 Sati 身份 UA（如 WEB_FETCH_USER_AGENT）。
 */
const PATENT_DOWNLOAD_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

/** fetch 兜底下载 CDN PDF 的每篇超时（毫秒）。 */
const FETCH_FALLBACK_TIMEOUT_MS = 60_000;

/** PDF 魔数（%PDF-，5 字节）。 */
const PDF_MAGIC = "%PDF-";

/** 错误页判定下限：小于该字节数的响应视为错误页不落盘（与 Python 侧阈值统一）。 */
const MIN_PDF_BYTES = 500;

/**
 * 浏览器拦截条目兜底：脚本返回 fallback（已提取 CDN URL）时，用 fetch 直接下载落盘。
 * 成功升格为 ok（method=http）；失败或无 URL 可重试则标记 failed（保留 pdfUrl 供手动重试）。
 *
 * 落盘安全（P1-01）：写入前校验 PDF 魔数与最小长度，Content-Type 为 text/html 时拒绝
 * （宽松策略，application/octet-stream 等不误杀）；先写 .tmp 再原子 rename，
 * 避免进程中断留下半写文件。
 *
 * 重试（P2-02）：复用 networkFetch 内置重试（指数退避 jitteredBackoff，base 1000ms ×2，
 * 与 Python 侧同参数）——HTTP 408/409/425/429/5xx 与网络错误（ECONNRESET/ETIMEDOUT 等）
 * 重试至多 3 次；404/403 与魔数错误属于确定性失败，不重试立即返回。
 */
const FETCH_RETRY_MAX_ATTEMPTS = 3;

export async function fetchPdfFallback(
  item: ScriptDownloadItem,
  outputDir: string,
  options: { signal?: AbortSignal; fetchImpl?: typeof fetch },
): Promise<PatentDownloadItem> {
  if (item.status === "ok") {
    return { patent: item.patent, status: "ok", path: item.path, pdfUrl: item.pdfUrl, method: "browser" };
  }
  if (!item.pdfUrl) {
    return { patent: item.patent, status: "failed", error: item.error };
  }
  const start = Date.now();
  const target = join(outputDir, `${item.patent}.pdf`);
  const tmp = `${target}.tmp`;
  try {
    const res = await networkFetch(
      item.pdfUrl,
      { headers: { "User-Agent": PATENT_DOWNLOAD_USER_AGENT, Accept: "application/pdf" } },
      {
        timeoutMs: FETCH_FALLBACK_TIMEOUT_MS,
        signal: options.signal,
        fetchImpl: options.fetchImpl,
        retry: { maxRetries: FETCH_RETRY_MAX_ATTEMPTS - 1 },
      },
    );
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
    const contentType = res.headers.get("content-type") ?? "";
    if (contentType.toLowerCase().includes("text/html")) {
      throw new Error(`unexpected Content-Type: ${contentType}`);
    }
    if (!res.body) throw new Error(`response too small (0 bytes), likely an error page`);
    // P2-04 流式写盘：先读首个 chunk 校验 PDF 魔数（不匹配立即取消并拒绝），
    // 再把剩余流 pipe 到 .tmp（20MB PDF 不再整读入内存，峰值仅一个 chunk）。
    const reader = res.body.getReader();
    const first = await reader.read();
    const firstBuf = first.done ? Buffer.alloc(0) : Buffer.from(first.value);
    if (firstBuf.length < PDF_MAGIC.length) {
      throw new Error(`response too small (${firstBuf.length} bytes), likely an error page`);
    }
    const magic = firstBuf.subarray(0, PDF_MAGIC.length).toString();
    if (magic !== PDF_MAGIC) {
      await reader.cancel().catch(() => {});
      throw new Error(`invalid PDF magic: ${JSON.stringify(magic)}`);
    }
    let size = firstBuf.length;
    const rest = new Readable({
      read() {
        reader.read().then(
          ({ done, value }) => {
            if (done) {
              this.push(null);
              return;
            }
            size += value.length;
            this.push(Buffer.from(value));
          },
          (err: unknown) => this.destroy(err instanceof Error ? err : new Error(String(err))),
        );
      },
    });
    const out = createWriteStream(tmp);
    out.write(firstBuf);
    await pipeline(rest, out);
    if (size < MIN_PDF_BYTES) throw new Error(`response too small (${size} bytes), likely an error page`);
    await rename(tmp, target);
    return {
      patent: item.patent,
      status: "ok",
      path: target,
      pdfUrl: item.pdfUrl,
      method: "http",
      durationMs: Date.now() - start,
    };
  } catch (fetchErr) {
    await unlink(tmp).catch(() => {});
    const reason = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    const base = item.error ? `${item.error}; ` : "";
    return {
      patent: item.patent,
      status: "failed",
      pdfUrl: item.pdfUrl,
      error: `${base}fetch fallback failed: ${reason}`,
      durationMs: Date.now() - start,
    };
  }
}
