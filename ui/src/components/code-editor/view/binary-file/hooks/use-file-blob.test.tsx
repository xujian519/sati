// Cancellation semantics of useFileBlob: closure `let cancelled` guard (then/catch/finally)
// plus the ref-based `lastRequestKeyRef` staleness detection.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFileBlob } from "./use-file-blob";

const apiMock = vi.hoisted(() => ({
  readFileBlob: vi.fn(),
  readOfficePdfPreviewBlob: vi.fn(),
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

function blobResponse(content: string) {
  return new Response(new Blob([content]), { status: 200 });
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useFileBlob cancellation", () => {
  beforeEach(() => {
    apiMock.readFileBlob.mockReset();
    apiMock.readOfficePdfPreviewBlob.mockReset();
  });

  afterEach(cleanup);

  it("drops a stale blob response when the file changes mid-flight", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.readFileBlob.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(({ filePath }) => useFileBlob("hundouluo", filePath, true), {
      initialProps: { filePath: "first.bin" },
    });

    rerender({ filePath: "second.bin" });

    await act(async () => {
      second.resolve(blobResponse("new"));
    });
    await waitFor(() => expect(result.current.blob?.size).toBe(3));

    await act(async () => {
      first.resolve(blobResponse("stale-content"));
    });
    await flush();

    expect(result.current.blob?.size).toBe(3);
  });

  it("does not publish a failure from a request that was cancelled", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.readFileBlob.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(({ filePath }) => useFileBlob("hundouluo", filePath, true), {
      initialProps: { filePath: "first.bin" },
    });

    rerender({ filePath: "second.bin" });

    await act(async () => {
      second.resolve(blobResponse("ok"));
    });
    await waitFor(() => expect(result.current.blob?.size).toBe(2));

    await act(async () => {
      first.reject(new Error("Failed to load file preview."));
    });
    await flush();

    expect(result.current.errorMessage).toBeNull();
    expect(result.current.errorCode).toBeNull();
  });

  it("does not clear the loading flag of the request that replaced it", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.readFileBlob.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(({ filePath }) => useFileBlob("hundouluo", filePath, true), {
      initialProps: { filePath: "first.bin" },
    });

    rerender({ filePath: "second.bin" });
    expect(result.current.loading).toBe(true);

    await act(async () => {
      first.resolve(blobResponse("stale"));
    });
    await flush();

    expect(result.current.loading).toBe(true);

    await act(async () => {
      second.resolve(blobResponse("live"));
    });
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it("does not issue a request while the project is unavailable", async () => {
    const { result } = renderHook(() => useFileBlob(undefined, "a.bin", true));

    await flush();

    expect(apiMock.readFileBlob).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.errorMessage).toBe("Project is not available.");
  });

  it("clears the stale blob as soon as the target file changes", async () => {
    apiMock.readFileBlob.mockResolvedValueOnce(blobResponse("first-file"));
    const pending = deferred<Response>();

    const { result, rerender } = renderHook(({ filePath }) => useFileBlob("hundouluo", filePath, true), {
      initialProps: { filePath: "first.bin" },
    });

    await waitFor(() => expect(result.current.blob?.size).toBe(10));

    apiMock.readFileBlob.mockImplementationOnce(() => pending.promise);
    rerender({ filePath: "second.bin" });

    expect(result.current.blob).toBeNull();
    expect(result.current.loading).toBe(true);
  });

  it("keeps the current blob when only a force reload of the same file is requested", async () => {
    apiMock.readFileBlob.mockResolvedValueOnce(blobResponse("first-file"));
    const pending = deferred<Response>();

    const { result } = renderHook(() => useFileBlob("hundouluo", "same.bin", true));
    await waitFor(() => expect(result.current.blob?.size).toBe(10));

    apiMock.readFileBlob.mockImplementationOnce(() => pending.promise);
    await act(async () => {
      result.current.reload({ force: true });
    });

    expect(result.current.blob?.size).toBe(10);
    expect(result.current.loading).toBe(true);
  });
});
