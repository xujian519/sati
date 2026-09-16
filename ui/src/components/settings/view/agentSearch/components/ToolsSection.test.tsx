import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SatiConfig } from "../../modelPool/types";
import { FieldSaveModeProvider } from "../../../shared/components/Inputs";
import ToolsSection from "./ToolsSection";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("../../../../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
}));

const GLM_ENDPOINT = "https://api.z.ai/api/paas/v4/web_search";

/**
 * 手写一份「带兄弟段」的配置：`tools.paperSearch` 由原始 YAML 写入，
 * 面板不渲染它。写侧若整段替换 `tools`，这个段就会从配置文件里消失。
 */
function configWithSibling(webSearch: NonNullable<NonNullable<SatiConfig["tools"]>["webSearch"]>): SatiConfig {
  return { tools: { webSearch, paperSearch: { enabled: true, arxiv: true } } };
}

/** 取出最后一次 onChange 载荷里的 tools 段。 */
function lastTools(onChange: ReturnType<typeof vi.fn>): NonNullable<SatiConfig["tools"]> {
  const calls = onChange.mock.calls;
  const next = calls[calls.length - 1]?.[0] as SatiConfig | undefined;
  return next?.tools ?? {};
}

describe("ToolsSection 写侧", () => {
  afterEach(cleanup);

  it("切换搜索 provider 时保留兄弟段 tools.paperSearch", () => {
    const onChange = vi.fn();
    const config = configWithSibling({ enabled: true, provider: "glm", apiKey: "k" });

    render(<ToolsSection config={config} onChange={onChange} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "tavily" } });

    const tools = lastTools(onChange);
    expect(tools.webSearch).toEqual({ enabled: true, provider: "tavily" });
    expect(tools.paperSearch).toEqual({ enabled: true, arxiv: true });
  });

  // immediate 模式下输入即 onChange（explicit 模式的保存按钮调用同一 onCommit，
  // 载荷一致），省去定位「编辑 → 保存」按钮的 DOM 依赖。
  it("清空 endpoint 时只清 webSearch 子键，不动兄弟段", () => {
    const onChange = vi.fn();
    const config = configWithSibling({ enabled: true, provider: "glm", endpoint: GLM_ENDPOINT });

    render(
      <FieldSaveModeProvider mode="immediate">
        <ToolsSection config={config} onChange={onChange} />
      </FieldSaveModeProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText(GLM_ENDPOINT), { target: { value: "" } });

    const tools = lastTools(onChange);
    expect(tools.webSearch).toEqual({ enabled: true, provider: "glm" });
    expect(tools.paperSearch).toEqual({ enabled: true, arxiv: true });
  });

  it("改自定义 provider 字段时保留兄弟段", () => {
    const onChange = vi.fn();
    const config = configWithSibling({ enabled: true, provider: "custom" });

    render(
      <FieldSaveModeProvider mode="immediate">
        <ToolsSection config={config} onChange={onChange} />
      </FieldSaveModeProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText("My Search"), { target: { value: "Internal" } });

    const tools = lastTools(onChange);
    expect(tools.webSearch).toEqual({
      enabled: true,
      provider: "custom",
      customProvider: { name: "Internal" },
    });
    expect(tools.paperSearch).toEqual({ enabled: true, arxiv: true });
  });
});
