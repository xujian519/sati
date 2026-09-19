import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SatiConfig } from "../../modelPool/types";
import AgentsSection from "./AgentsSection";

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

// t 支持插值，否则 windowFact 的 tokens/via 无法断言（真实 i18n 会替换 {{...}}）。
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && typeof options === "object" ? `${key}:${Object.values(options).join("|")}` : key,
  }),
}));
vi.mock("../../../../../utils/api", () => ({ authenticatedFetch: mocks.authenticatedFetch }));
vi.mock("../../../../../shared/useDynamicModelOptions", () => ({ useDynamicModelOptions: () => [] }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const BASE: SatiConfig = {
  agent: { model: "relay/custom-model" },
  model: {
    providers: {
      relay: { protocol: "openai", url: "https://relay.test/v1", apiKey: "k", models: { "custom-model": {} } },
    },
  },
};

function respond(entries: Record<string, unknown>) {
  mocks.authenticatedFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ exists: true, entries }),
  } as unknown as Response);
}

describe("AgentsSection 窗口覆盖层提示（#449）", () => {
  it("没有探测/实测事实时不渲染该行", async () => {
    respond({});
    render(<AgentsSection config={BASE} onChange={vi.fn()} />);
    await waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalled());
    expect(screen.queryByText("satiConfig.panels.agents.capabilities.windowAdopt")).toBeNull();
  });

  it("有事实时显示来源与字段，点击采纳把值写进 agent.maxContextTokens", async () => {
    respond({
      "relay/custom-model": { maxContextTokens: 262144, source: "probe", via: "context_length" },
    });
    const onChange = vi.fn();
    render(<AgentsSection config={BASE} onChange={onChange} />);

    const adopt = await screen.findByText("satiConfig.panels.agents.capabilities.windowAdopt");
    // 探测行的唯一标识是命中字段名（t 被 mock 成带插值的形态）。
    expect(screen.getByText(/context_length/)).toBeTruthy();
    // 且覆盖层已参与解析：生效值文案与探测行都出现 262,144（不再是协议默认 128,000）。
    expect(screen.getAllByText(/262,144/).length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText(/128,000/)).toBeNull();

    fireEvent.click(adopt);

    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SatiConfig;
    expect(next.agent?.maxContextTokens).toBe(262144);
    // 采纳只动 agent 上限，不碰 provider/model 声明。
    expect(next.model?.providers?.relay?.models?.["custom-model"]).toEqual({});
  });

  it("observed（实测）事实同样可采纳", async () => {
    respond({ "relay/custom-model": { maxContextTokens: 131072, source: "observed", via: "provider-context-cap" } });
    const onChange = vi.fn();
    render(<AgentsSection config={BASE} onChange={onChange} />);

    fireEvent.click(await screen.findByText("satiConfig.panels.agents.capabilities.windowAdopt"));
    expect((onChange.mock.calls[0][0] as SatiConfig).agent?.maxContextTokens).toBe(131072);
  });
});
