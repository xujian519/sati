// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StylePanelProvider, useStylePanel } from "./StylePanelContext";
import StylePanelDrawer from "./StylePanelDrawer";

// 测试环境未初始化 i18n；mock useTranslation 返回固定翻译表（缺失 key 回退 key 本身）。
const TEST_TRANSLATIONS: Record<string, string> = {
  "panel.title": "文书排版调参",
  "panel.close": "关闭面板",
  "group.fontSize": "字号",
  "fontSize.base": "小四（正文）",
  "actions.exportHtml": "导出 HTML",
  "actions.savePreset": "保存预设",
  "actions.exportPdf": "导出 PDF",
  "actions.presetPlaceholder": "预设名称…",
  "preview.title": "文书排版实时预览",
  "preview.retry": "重试",
  "preview.readFailed": "读取文书文件失败",
  "preview.noProject": "未选择项目，无法读取文书文件",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => TEST_TRANSLATIONS[key] ?? key,
  }),
}));

// api.readFile mock：返回一份最小 HTML
vi.mock("../../../utils/api", () => ({
  api: {
    readFile: vi.fn(async () =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          content:
            '<!doctype html><html><head><style>html{font-size:var(--doc-text-base)}</style></head><body><p id="x">正文</p></body></html>',
        }),
      }),
    ),
  },
}));

function OpenDrawerHarness() {
  const { openPanel } = useStylePanel();
  return (
    <button type="button" onClick={() => openPanel("/workspace/docs/out.html", { fontSize: { base: "12pt" } })}>
      open
    </button>
  );
}

function renderHarness(sendMessage: (msg: Record<string, unknown>) => void = () => {}) {
  const utils = render(
    <StylePanelProvider>
      <OpenDrawerHarness />
      <StylePanelDrawer
        sendMessage={sendMessage}
        projectName="demo"
        projectPath="/workspace"
        sessionId="s1"
        provider="sati"
      />
    </StylePanelProvider>,
  );
  return utils;
}

afterEach(cleanup);

describe("StylePanelDrawer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:mock");
    vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    const originalCreateElement = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string): HTMLElement => {
      const element = originalCreateElement(tagName);
      if (tagName === "a") {
        // jsdom 不实现锚点点击下载；替换 click 为 spy，防止未实现导航报错。
        element.click = vi.fn();
      }
      return element;
    });
  });

  it("不打开时渲染空", () => {
    renderHarness();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("openPanel 后渲染表单与预览，标题含文件名", async () => {
    renderHarness();
    fireEvent.click(screen.getByText("open"));
    expect(await screen.findByRole("dialog")).toBeTruthy();
    expect(screen.getByText("out.html")).toBeTruthy();
    // 字号分组表单存在
    expect(screen.getByText("字号")).toBeTruthy();
  });

  it("修改字号即时回调更新（select 变更触发预览重渲染）", async () => {
    renderHarness();
    fireEvent.click(screen.getByText("open"));
    const baseSelect = (await screen.findByLabelText("小四（正文）")) as HTMLSelectElement;
    fireEvent.change(baseSelect, { target: { value: "14pt" } });
    expect(baseSelect.value).toBe("14pt");
  });

  it("导出 HTML 触发本地下载（Blob + click）", async () => {
    renderHarness();
    fireEvent.click(screen.getByText("open"));
    // 文书 HTML 为异步读取，srcdoc 就绪前导出按钮处于 disabled；等待其可用后再点击，
    // 避免 flaky 竞态（点击 disabled 按钮不会触发下载）。
    const exportButton = await screen.findByRole("button", { name: "导出 HTML" });
    await waitFor(() => expect((exportButton as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(exportButton);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("保存预设发送 sati-command", async () => {
    const sendMessage = vi.fn();
    renderHarness(sendMessage);
    fireEvent.click(screen.getByText("open"));
    const nameInput = (await screen.findByPlaceholderText("预设名称…")) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "所内规范" } });
    fireEvent.click(screen.getByText("保存预设"));
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "sati-command",
        options: expect.objectContaining({ sessionId: "s1", projectPath: "/workspace" }),
      }),
    );
    const command = (sendMessage.mock.calls[0][0] as { command: string }).command;
    expect(command).toContain("所内规范");
    expect(command).toContain("12pt");
  });

  it("导出 PDF 发送 sati-command 且含 htmlPath", async () => {
    const sendMessage = vi.fn();
    renderHarness(sendMessage);
    fireEvent.click(screen.getByText("open"));
    fireEvent.click(await screen.findByText("导出 PDF"));
    const command = (sendMessage.mock.calls[0][0] as { command: string }).command;
    expect(command).toContain("/workspace/docs/out.html");
  });

  it("关闭按钮触发 closePanel（对话框消失）", async () => {
    renderHarness();
    fireEvent.click(screen.getByText("open"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(screen.getByLabelText("关闭面板"));
    await act(async () => {});
    expect(dialog.isConnected).toBe(false);
  });
});
