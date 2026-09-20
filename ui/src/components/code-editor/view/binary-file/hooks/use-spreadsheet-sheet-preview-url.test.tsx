// Cancellation semantics of useSpreadsheetSheetPreviewUrl: AbortController + preflight body
// drain, driven by the object-argument form (sheet switch / refresh key).
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSpreadsheetSheetPreviewUrl } from "./use-spreadsheet-sheet-preview-url";

const apiMock = vi.hoisted(() => ({
  spreadsheetSheetPreviewUrl: vi.fn(),
  preflightSpreadsheetSheetPreview: vi.fn(),
}));

vi.mock("../../../../../utils/api", () => ({ api: apiMock }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => {
    resolve = res;
  });
  return { promise, resolve };
}

function signalOf(call: number) {
  return apiMock.preflightSpreadsheetSheetPreview.mock.calls[call][3].signal as AbortSignal;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSpreadsheetSheetPreviewUrl cancellation", () => {
  beforeEach(() => {
    apiMock.spreadsheetSheetPreviewUrl.mockReset();
    apiMock.preflightSpreadsheetSheetPreview.mockReset();
    apiMock.spreadsheetSheetPreviewUrl.mockReturnValue("/api/sheet-preview");
  });

  afterEach(cleanup);

  it("does not request a worksheet preview while no sheet is selected", async () => {
    const { result } = renderHook(() =>
      useSpreadsheetSheetPreviewUrl({
        projectName: "hundouluo",
        filePath: "a.xlsx",
        sheetIndex: null,
        revision: "r1",
        refreshKey: 0,
        enabled: true,
      }),
    );

    await flush();

    expect(apiMock.preflightSpreadsheetSheetPreview).not.toHaveBeenCalled();
    expect(result.current.previewUrl).toBeNull();
    expect(result.current.loading).toBe(false);
  });

  it("drains the worksheet preflight body before publishing the url", async () => {
    const response = new Response(new Blob(["%PDF"]), { status: 206 });
    const drain = vi.spyOn(response, "arrayBuffer");
    apiMock.preflightSpreadsheetSheetPreview.mockResolvedValue(response);

    const { result } = renderHook(() =>
      useSpreadsheetSheetPreviewUrl({
        projectName: "hundouluo",
        filePath: "a.xlsx",
        sheetIndex: 0,
        revision: "r1",
        refreshKey: 0,
        enabled: true,
      }),
    );

    await waitFor(() => expect(result.current.previewUrl).toBe("/api/sheet-preview"));
    expect(drain).toHaveBeenCalledTimes(1);
  });

  it("aborts the previous worksheet request when the sheet changes", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    apiMock.preflightSpreadsheetSheetPreview
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    apiMock.spreadsheetSheetPreviewUrl.mockReturnValueOnce("/api/sheet-0").mockReturnValueOnce("/api/sheet-1");

    const { result, rerender } = renderHook(
      ({ sheetIndex }) =>
        useSpreadsheetSheetPreviewUrl({
          projectName: "hundouluo",
          filePath: "a.xlsx",
          sheetIndex,
          revision: "r1",
          refreshKey: 0,
          enabled: true,
        }),
      { initialProps: { sheetIndex: 0 } },
    );

    expect(signalOf(0).aborted).toBe(false);

    rerender({ sheetIndex: 1 });
    expect(signalOf(0).aborted).toBe(true);

    await act(async () => {
      second.resolve(new Response(null, { status: 206 }));
    });
    await waitFor(() => expect(result.current.previewUrl).toBe("/api/sheet-1"));

    await act(async () => {
      first.resolve(new Response(null, { status: 206 }));
    });
    await flush();

    expect(result.current.previewUrl).toBe("/api/sheet-1");
  });
});
