// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SpreadsheetPreview from "./SpreadsheetPreview";

const reloadInteractiveMock = vi.hoisted(() => vi.fn());
const reloadManifestMock = vi.hoisted(() => vi.fn());

/** 服务端下发的原始异常文本——它不该出现在用户可见的提示里。 */
const RAW_SERVER_ERROR = "Error: Unexpected token < in JSON at position 0 at parseWorkbook (bundle.js:1234)";

/** 可变的 hook 返回态，让每个用例自选「有码」还是「无码」。 */
const interactiveState = vi.hoisted(() => ({
  errorMessage: null as string | null,
  errorCode: null as string | null,
}));

vi.mock("../../hooks/use-spreadsheet-interactive-preview", () => ({
  useSpreadsheetInteractivePreview: () => ({
    data: null,
    errorMessage: interactiveState.errorMessage,
    errorCode: interactiveState.errorCode,
    loading: false,
    reload: reloadInteractiveMock,
  }),
}));

vi.mock("../../hooks/use-spreadsheet-preview-manifest", () => ({
  useSpreadsheetPreviewManifest: () => ({
    manifest: null,
    errorMessage: null,
    errorCode: null,
    loading: false,
    reload: reloadManifestMock,
    refreshKey: 0,
  }),
}));

vi.mock("../../hooks/use-spreadsheet-sheet-preview-url", () => ({
  useSpreadsheetSheetPreviewUrl: () => ({
    previewUrl: null,
    errorMessage: null,
    errorCode: null,
    loading: false,
  }),
}));

vi.mock("../../hooks/use-office-auto-refresh", () => ({
  useOfficeAutoRefresh: () => undefined,
}));

beforeEach(() => {
  // 默认：服务端给了错误码，走按码映射。
  interactiveState.errorCode = "SPREADSHEET_INTERACTIVE_PARSE_FAILED";
  interactiveState.errorMessage = RAW_SERVER_ERROR;
});

afterEach(() => {
  cleanup();
  reloadInteractiveMock.mockClear();
  reloadManifestMock.mockClear();
});

const file = { name: "book.xlsx", path: "book.xlsx", type: "file", extension: "xlsx" } as never;

function renderPreview() {
  return render(
    <SpreadsheetPreview
      service="builtin"
      projectName="demo"
      file={file}
      title="book.xlsx"
      onClose={vi.fn()}
      isFullscreen={false}
    />,
  );
}

describe("SpreadsheetPreview failure messaging", () => {
  it("does not surface the raw server exception to the user", () => {
    renderPreview();

    expect(screen.queryByText(RAW_SERVER_ERROR)).toBeNull();
    // 按错误码给出可操作的说明（文案取自 i18n，此处只断言不是原始异常）。
    expect(screen.queryByText(/Unexpected token/)).toBeNull();
  });

  it("keeps the hook's own message when the failure carries no server error code", () => {
    // code 为 null 时不能直接丢给通用文案：hook 在 projectName 缺失时给的是
    // "Project is not available."，客户端侧失败（如 "Interactive workbook data
    // is incomplete."）同样无 code——这些恰恰是用户唯一可据以行动的信息。
    interactiveState.errorCode = null;
    interactiveState.errorMessage = "Project is not available.";

    renderPreview();

    expect(screen.queryByText("Project is not available.")).not.toBeNull();
  });

  it("offers a retry action that re-runs the preview", () => {
    renderPreview();

    // 失败态此前只有下载与去设置两个出口；重试按钮是新增的第三个，且必须真的重新拉取。
    // （测试环境的 i18n 是 passthrough，文案即 key。）
    fireEvent.click(screen.getByRole("button", { name: "officePreview.retry" }));

    expect(reloadInteractiveMock).toHaveBeenCalledTimes(1);
  });
});
