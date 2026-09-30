// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import LlmConfigurationStep from "./LlmConfigurationStep";

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchRemoteDefaultModels: vi.fn(),
}));

vi.mock("../../../../utils/api", () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock("../../../../shared/modelListApi", () => ({
  fetchProviderModels: mocks.fetchProviderModels,
  fetchRemoteDefaultModels: mocks.fetchRemoteDefaultModels,
}));

describe("LlmConfigurationStep", () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/config/provider") {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      return { ok: true, json: async () => ({}) };
    });
    mocks.fetchRemoteDefaultModels.mockResolvedValue([]);
    mocks.fetchProviderModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("fetches Ollama models through the no-key provider path without catalog fallback", async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith("deepseek");
    });

    mocks.fetchRemoteDefaultModels.mockClear();
    mocks.fetchProviderModels.mockClear();
    mocks.fetchProviderModels.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    fireEvent.click(screen.getByRole("button", { name: /^Ollama$/ }));

    await waitFor(() => {
      expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1);
    });

    expect(mocks.fetchProviderModels).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "ollama",
        protocol: "openai",
        baseUrl: "http://localhost:11434/v1",
        apiKey: "",
      }),
    );
    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    // Ollama 无 bundled 模型列表可回退：拉取失败时提示错误并允许手动输入。
    await waitFor(() => {
      expect(screen.getByText(/ECONNREFUSED/)).toBeTruthy();
    });
  });

  it("enables Save once the form is complete, without requiring a connection test", async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    const saveButton = () => screen.getByRole("button", { name: "llmSetup.save" });
    // 默认 provider（DeepSeek）需要 API key：表单未齐备时不可保存。
    expect(saveButton().hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("llmSetup.apiKeyPlaceholder"), {
      target: { value: "sk-test" },
    });

    // 从未点过"测试连接"，表单齐备即可保存——连接测试是诊断手段，不是准入门槛。
    await waitFor(() => {
      expect(saveButton().hasAttribute("disabled")).toBe(false);
    });
    expect(screen.getByText("llmSetup.testOptional")).toBeTruthy();
  });
});
