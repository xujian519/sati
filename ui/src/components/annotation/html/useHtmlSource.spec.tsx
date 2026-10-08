/**
 * useHtmlSource 的读取 / 字节哈希 / 取消语义（H2）。
 *
 * 字节哈希必须与 dsh 的 `fileDigest`（字节 SHA-256）一致；无 `crypto.subtle` 时
 * 报告 `hashUnavailable`——调用方据此禁写侧车。
 */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computeByteSha256Hex, decodeHtmlSourceText, useHtmlSource } from "./useHtmlSource";

const apiMock = vi.hoisted(() => ({ readFileBlob: vi.fn() }));
vi.mock("../../../utils/api", () => ({ api: apiMock }));

/** SHA-256("abc") 的已知向量。 */
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

function responseWith(text: string, status = 200) {
  return new Response(new TextEncoder().encode(text), { status });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("computeByteSha256Hex / decodeHtmlSourceText", () => {
  it("matches the known SHA-256 vector and decodes UTF-8", async () => {
    const bytes = new TextEncoder().encode("abc").buffer;
    expect(await computeByteSha256Hex(bytes)).toBe(ABC_SHA256);
    expect(decodeHtmlSourceText(new TextEncoder().encode("你好").buffer)).toBe("你好");
  });

  it("returns null when crypto.subtle is unavailable (非安全上下文禁写)", async () => {
    vi.stubGlobal("crypto", {});
    expect(await computeByteSha256Hex(new TextEncoder().encode("abc").buffer)).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe("useHtmlSource", () => {
  beforeEach(() => {
    apiMock.readFileBlob.mockReset();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("reads bytes, keeps the byte hash and surfaces the source text", async () => {
    apiMock.readFileBlob.mockResolvedValue(responseWith("abc"));

    const { result } = renderHook(() => useHtmlSource("demo", "report.html"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");

    expect(result.current.sha256).toBe(ABC_SHA256);
    expect(result.current.hashUnavailable).toBe(false);
    expect(result.current.sourceText).toBe("abc");
  });

  it("flags hashUnavailable when crypto.subtle is missing", async () => {
    vi.stubGlobal("crypto", {});
    apiMock.readFileBlob.mockResolvedValue(responseWith("abc"));

    const { result } = renderHook(() => useHtmlSource("demo", "report.html"));
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");

    expect(result.current.sha256).toBeNull();
    expect(result.current.hashUnavailable).toBe(true);
  });

  it("reports a read failure as an error state", async () => {
    apiMock.readFileBlob.mockResolvedValue(responseWith("", 404));

    const { result } = renderHook(() => useHtmlSource("demo", "missing.html"));
    await waitFor(() => expect(result.current.status).toBe("error"));
  });

  it("drops a stale response when the file changes mid-flight", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.readFileBlob.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(({ filePath }) => useHtmlSource("demo", filePath), {
      initialProps: { filePath: "first.html" },
    });
    rerender({ filePath: "second.html" });

    await act(async () => {
      second.resolve(responseWith("second"));
    });
    await waitFor(() => expect(result.current.status).toBe("ready"));
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.sourceText).toBe("second");

    await act(async () => {
      first.resolve(responseWith("first"));
    });
    if (result.current.status !== "ready") throw new Error("unreachable");
    expect(result.current.sourceText).toBe("second");
  });

  it("stays idle without a project or path", () => {
    const { result } = renderHook(() => useHtmlSource(undefined, undefined));
    expect(result.current.status).toBe("idle");
    expect(apiMock.readFileBlob).not.toHaveBeenCalled();
  });
});
