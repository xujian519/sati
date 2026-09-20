// Cancellation semantics of useSpreadsheetInteractivePreview: AbortController guard around
// the payload validation and the state writes of a stale workbook response.
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpreadsheetInteractivePreview } from "./use-spreadsheet-interactive-preview";

const apiMock = vi.hoisted(() => ({
  spreadsheetInteractivePreview: vi.fn(),
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

function interactivePayload(revision: string) {
  return {
    version: 1,
    revision,
    activeSheetIndex: 0,
    sheets: [{ index: 0, name: "Sheet1" }],
    warnings: [],
    workbook: { id: "workbook-1" },
  };
}

function signalOf(call: number) {
  return apiMock.spreadsheetInteractivePreview.mock.calls[call][2].signal as AbortSignal;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSpreadsheetInteractivePreview cancellation", () => {
  beforeEach(() => {
    apiMock.spreadsheetInteractivePreview.mockReset();
  });

  afterEach(cleanup);

  it("discards a stale workbook when the newer request already landed", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.spreadsheetInteractivePreview
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);

    const { result, rerender } = renderHook(
      ({ filePath }) => useSpreadsheetInteractivePreview("hundouluo", filePath, true),
      { initialProps: { filePath: "first.xlsx" } },
    );

    rerender({ filePath: "second.xlsx" });

    await act(async () => {
      second.resolve(jsonResponse(interactivePayload("live")));
    });
    await waitFor(() => expect(result.current.data?.revision).toBe("live"));

    await act(async () => {
      first.resolve(jsonResponse(interactivePayload("stale")));
    });
    await flush();

    expect(result.current.data?.revision).toBe("live");
  });

  it("reports an incomplete workbook for the live request only", async () => {
    const pending = deferred<Response>();
    apiMock.spreadsheetInteractivePreview.mockImplementation(() => pending.promise);

    const { result } = renderHook(() => useSpreadsheetInteractivePreview("hundouluo", "a.xlsx", true));

    await act(async () => {
      pending.resolve(jsonResponse({ version: 1, revision: "x", activeSheetIndex: 0, sheets: [], warnings: [] }));
    });

    await waitFor(() => expect(result.current.errorMessage).toBe("Interactive workbook data is incomplete."));
    expect(result.current.loading).toBe(false);
  });

  it("does not request workbook data while the hook is disabled", async () => {
    const { result } = renderHook(() => useSpreadsheetInteractivePreview("hundouluo", "a.xlsx", false));

    await flush();

    expect(apiMock.spreadsheetInteractivePreview).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.errorMessage).toBeNull();
  });

  it("aborts the in-flight workbook request on unmount", async () => {
    const pending = deferred<Response>();
    apiMock.spreadsheetInteractivePreview.mockImplementation(() => pending.promise);

    const { unmount } = renderHook(() => useSpreadsheetInteractivePreview("hundouluo", "a.xlsx", true));
    expect(signalOf(0).aborted).toBe(false);

    unmount();

    expect(signalOf(0).aborted).toBe(true);
  });
});
