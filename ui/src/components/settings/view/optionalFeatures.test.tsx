import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import RouterSection from "./agentRoute/components/RouterSection";
import ToolsSection from "./agentSearch/components/ToolsSection";
import type { SatiConfig } from "./modelPool/types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

// 路由面板的模型下拉走动态目录（fetches /api/config/models）；本用例只关心开关态。
vi.mock("../../../../shared/useDynamicModelOptions", () => ({
  useDynamicModelOptions: () => [],
}));

afterEach(cleanup);

const BASE: SatiConfig = {
  agent: { model: "test/model" },
  model: {
    providers: {
      test: { protocol: "openai", url: "https://example.test/v1", apiKey: "test", models: { model: {} } },
    },
  },
};

const ROUTER_SWITCH = "satiConfig.panels.router.enabled.label";
const WEB_SEARCH_SWITCH = "satiConfig.panels.tools.enabled.label";
const PAPER_SEARCH_SWITCH = "satiConfig.panels.tools.paperSearch.enabled.label";

function renderPanels(config: SatiConfig) {
  return render(
    <>
      <RouterSection config={config} onChange={vi.fn()} />
      <ToolsSection config={config} onChange={vi.fn()} />
    </>,
  );
}

function checked(name: string): string | null {
  return screen.getByRole("switch", { name }).getAttribute("aria-checked");
}

/**
 * 面板与运行期同判据（上游 #588）：段缺失 = 关，段存在但无 enabled = 开，
 * 显式 true/false 优先。任一处偏差都会造成「面板显示开、实际关」。
 */
describe("可选功能开关四态", () => {
  it.each([
    ["未配置", {}, false],
    ["显式关", { router: { enabled: false }, tools: { webSearch: { enabled: false } } }, false],
    ["显式开", { router: { enabled: true }, tools: { webSearch: { enabled: true } } }, true],
    ["遗留已配置（段在、无 enabled）", { router: {}, tools: { webSearch: {} } }, true],
  ])("router 与 web 搜索：%s", (_label, sections, expected) => {
    renderPanels({ ...BASE, ...(sections as Partial<SatiConfig>) });

    expect(checked(ROUTER_SWITCH)).toBe(String(expected));
    expect(checked(WEB_SEARCH_SWITCH)).toBe(String(expected));
  });

  it("paper 搜索与 web 搜索各自独立（段在场状态互不影响）", () => {
    renderPanels({ ...BASE, tools: { webSearch: { enabled: false }, paperSearch: { enabled: true } } });

    expect(checked(WEB_SEARCH_SWITCH)).toBe("false");
    expect(checked(PAPER_SEARCH_SWITCH)).toBe("true");
  });

  it("未配置 paper 搜索时开关为关", () => {
    renderPanels(BASE);

    expect(checked(PAPER_SEARCH_SWITCH)).toBe("false");
  });

  it("打开被显式关闭的搜索开关会写出 enabled: true（只写自己的子键）", () => {
    const onChange = vi.fn();
    render(
      <ToolsSection
        config={{ ...BASE, tools: { paperSearch: { enabled: false, arxiv: false } } }}
        onChange={onChange}
      />,
    );

    fireEvent.click(screen.getByRole("switch", { name: PAPER_SEARCH_SWITCH }));

    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({ tools: { paperSearch: { enabled: true, arxiv: false } } }),
    );
  });
});
