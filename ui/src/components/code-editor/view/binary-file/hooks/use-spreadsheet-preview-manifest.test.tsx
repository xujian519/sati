// Cancellation semantics of useSpreadsheetPreviewManifest: AbortController guard around the
// worksheet validation (empty workbook) and around the state writes of a stale manifest.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpreadsheetPreviewManifest } from "./use-spreadsheet-preview-manifest";

const apiMock = vi.hoisted(() => ({
  spreadsheetPreviewManifest: vi.fn(),
}));

vi.mock("../../../../../utils/api", () => ({ api: apiMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function manifestPayload(revision: string) {
  return {
    version: 1,
    revision,
    activeSheetIndex: 0,
    sheets: [{ index: 0, name: "Sheet1" }],
  };
}

function signalOf(call: number) {
  return apiMock.spreadsheetPreviewManifest.mock.calls[call][2].signal as AbortSignal;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSpreadsheetPreviewManifest cancellation", () => {
  beforeEach(() => {
    apiMock.spreadsheetPreviewManifest.mockReset();
  });

  afterEach(cleanup);

  it("discards a stale manifest when the newer request already landed", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.spreadsheetPreviewManifest
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(
      ({ filePath }) => useSpreadsheetPreviewManifest("hundouluo", filePath, true),
      {
        initialProps: { filePath: "first.xlsx" },
      },
    );

    rerender({ filePath: "second.xlsx" });

    await act(async () => {
      second.resolve(jsonResponse(manifestPayload("live")));
    });
    await waitFor(() => expect(result.current.manifest?.revision).toBe("live"));

    await act(async () => {
      first.resolve(jsonResponse(manifestPayload("stale")));
    });
    await flush();

    expect(result.current.manifest?.revision).toBe("live");
  });

  it("reports a workbook without a visible worksheet instead of rendering nothing", async () => {
    const pending = deferred<Response>();
    apiMock.spreadsheetPreviewManifest.mockImplementation(() => pending.promise);

    const { result } = renderHook(() => useSpreadsheetPreviewManifest("hundouluo", "a.xlsx", true));

    await act(async () => {
      pending.resolve(jsonResponse({ version: 1, revision: "empty", activeSheetIndex: 0, sheets: [] }));
    });

    await waitFor(() => expect(result.current.errorMessage).toBe("The workbook does not contain a visible worksheet."));
    expect(result.current.manifest).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("aborts the in-flight manifest request on unmount", async () => {
    const pending = deferred<Response>();
    apiMock.spreadsheetPreviewManifest.mockImplementation(() => pending.promise);

    const { unmount } = renderHook(() => useSpreadsheetPreviewManifest("hundouluo", "a.xlsx", true));
    expect(signalOf(0).aborted).toBe(false);

    unmount();

    expect(signalOf(0).aborted).toBe(true);
  });
});
