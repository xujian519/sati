// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../utils/api";
import { ContextInspector } from "./ContextInspector";

vi.mock("../../utils/api", () => ({
  api: { sessionModelContext: vi.fn() },
}));

const mockedContext = vi.mocked(api.sessionModelContext);

function response(body: unknown, ok = true): Response {
  return { ok, status: ok ? 200 : 500, json: async () => body } as Response;
}

const snapshot = {
  version: 1,
  turnId: "turn-1",
  capturedAt: "2026-11-07T00:00:00.000Z",
  provider: "test-provider",
  model: "test-model",
  systemPrompt: "System alpha instructions",
  tools: [{ name: "read_file", description: "Read a file", inputSchema: { type: "object" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
  breakdown: { systemPromptChars: 26, toolsChars: 80, messagesChars: 60 },
  mediaOmitted: true,
};

function renderInspector() {
  const onClose = vi.fn();
  render(<ContextInspector request={{ sessionId: "session-1" }} onClose={onClose} />);
  return { onClose };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ContextInspector", () => {
  it("加载并展示 system prompt，按需请求快照", async () => {
    mockedContext.mockResolvedValue(response({ modelContext: snapshot, modelContextStatus: "available" }));
    renderInspector();

    expect(await screen.findByText("System alpha instructions")).toBeTruthy();
    expect(mockedContext).toHaveBeenCalledWith("session-1", expect.objectContaining({ mode: "true" }));
  });

  it("切换分区查看 tools 与 messages", async () => {
    mockedContext.mockResolvedValue(response({ modelContext: snapshot, modelContextStatus: "available" }));
    renderInspector();
    await screen.findByText("System alpha instructions");

    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(screen.getByText("read_file")).toBeTruthy();
    expect(screen.getByText("Read a file")).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Messages" }));
    expect(screen.getByText("user")).toBeTruthy();
  });

  it("搜索无匹配时显示空状态", async () => {
    mockedContext.mockResolvedValue(response({ modelContext: snapshot, modelContextStatus: "available" }));
    renderInspector();
    await screen.findByText("System alpha instructions");

    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    fireEvent.change(screen.getByPlaceholderText("Search context…"), { target: { value: "no-such-tool" } });

    expect(await screen.findByText("No matches.")).toBeTruthy();
  });

  it("没有快照时显示缺失状态", async () => {
    mockedContext.mockResolvedValue(response({ modelContextStatus: "missing" }));
    renderInspector();

    expect(await screen.findByText("No snapshot yet. It becomes available after the next model request.")).toBeTruthy();
  });

  it("Esc 关闭", async () => {
    mockedContext.mockResolvedValue(response({ modelContextStatus: "missing" }));
    const { onClose } = renderInspector();
    await screen.findByRole("dialog");

    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
