// Cancellation semantics of useOfficePdfPreviewUrl: AbortController + preflight body drain
// (the abort is the only cancel channel; a late response must be discarded).
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useOfficePdfPreviewUrl } from "./use-office-pdf-preview-url";

const apiMock = vi.hoisted(() => ({
  officePdfPreviewUrl: vi.fn(),
  preflightOfficePdfPreview: vi.fn(),
}));

vi.mock("../../../../../utils/api", () => ({ api: apiMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function signalOf(call: number) {
  return apiMock.preflightOfficePdfPreview.mock.calls[call][2].signal as AbortSignal;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useOfficePdfPreviewUrl cancellation", () => {
  beforeEach(() => {
    apiMock.officePdfPreviewUrl.mockReset();
    apiMock.preflightOfficePdfPreview.mockReset();
    apiMock.officePdfPreviewUrl.mockReturnValue("/api/office-pdf-preview");
  });

  afterEach(cleanup);

  it("aborts the in-flight preflight when the target file changes", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.preflightOfficePdfPreview
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { rerender } = renderHook(({ filePath }) => useOfficePdfPreviewUrl("hundouluo", filePath, true), {
      initialProps: { filePath: "first.docx" },
    });

    expect(signalOf(0).aborted).toBe(false);

    rerender({ filePath: "second.docx" });

    expect(signalOf(0).aborted).toBe(true);
    expect(signalOf(1).aborted).toBe(false);
  });

  it("keeps the newest preview url when the aborted preflight resolves late", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.preflightOfficePdfPreview
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    apiMock.officePdfPreviewUrl.mockReturnValueOnce("/api/first").mockReturnValueOnce("/api/second");

    const { result, rerender } = renderHook(({ filePath }) => useOfficePdfPreviewUrl("hundouluo", filePath, true), {
      initialProps: { filePath: "first.docx" },
    });

    rerender({ filePath: "second.docx" });

    await act(async () => {
      second.resolve(new Response(null, { status: 200 }));
    });
    await waitFor(() => expect(result.current.previewUrl).toBe("/api/second"));

    await act(async () => {
      first.resolve(new Response(null, { status: 200 }));
    });
    await flush();

    expect(result.current.previewUrl).toBe("/api/second");
  });

  it("drains the preflight body to release the connection", async () => {
    const response = new Response(new Blob(["%PDF"]), { status: 200 });
    const drain = vi.spyOn(response, "arrayBuffer");
    apiMock.preflightOfficePdfPreview.mockResolvedValue(response);

    const { result } = renderHook(() => useOfficePdfPreviewUrl("hundouluo", "a.docx", true));

    await waitFor(() => expect(result.current.previewUrl).toBe("/api/office-pdf-preview"));
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("ignores the abort error of a cancelled preflight", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.preflightOfficePdfPreview
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(({ filePath }) => useOfficePdfPreviewUrl("hundouluo", filePath, true), {
      initialProps: { filePath: "first.docx" },
    });

    rerender({ filePath: "second.docx" });

    const abortError = new Error("The operation was aborted.");
    abortError.name = "AbortError";
    await act(async () => {
      first.reject(abortError);
    });
    await flush();

    expect(result.current.errorMessage).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });

  it("does not preflight while the project is unavailable", async () => {
    const { result } = renderHook(() => useOfficePdfPreviewUrl(undefined, "a.docx", true));

    await flush();

    expect(apiMock.preflightOfficePdfPreview).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.errorMessage).toBe("Project is not available.");
  });

  it("aborts the in-flight preflight on unmount", async () => {
    const pending = deferred<Response>();
    apiMock.preflightOfficePdfPreview.mockImplementation(() => pending.promise);

    const { unmount } = renderHook(() => useOfficePdfPreviewUrl("hundouluo", "a.docx", true));
    expect(signalOf(0).aborted).toBe(false);

    unmount();

    expect(signalOf(0).aborted).toBe(true);
  });
});
