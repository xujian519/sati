import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HookTrustSnapshot } from "../types/types";
import { HookTrustBanner } from "./HookTrustBanner";

const list = vi.fn();
const decide = vi.fn();

vi.mock("../../../utils/api", () => ({
  api: {
    hookTrust: {
      list: (...args: unknown[]) => list(...args) as Promise<unknown>,
      decide: (...args: unknown[]) => decide(...args) as Promise<unknown>,
    },
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));

function snapshot(entries: HookTrustSnapshot["entries"]): HookTrustSnapshot {
  return { workspaceIdentityKey: "ws", entries };
}

const PENDING = snapshot([
  {
    pluginId: "x@project",
    pluginName: "x",
    pluginRoot: "/repo/.sati/plugins/x",
    status: "pending",
    hooks: [{ event: "PreToolUse", kind: "command", summary: "npx prettier --write $FILE" }],
  },
]);

describe("HookTrustBanner", () => {
  beforeEach(() => {
    list.mockReset();
    decide.mockReset();
  });

  afterEach(() => cleanup());

  it("全部已评审时不渲染任何东西", async () => {
    list.mockResolvedValue(
      snapshot([
        {
          pluginId: "x@project",
          pluginName: "x",
          pluginRoot: "/repo/.sati/plugins/x",
          status: "trusted",
          hooks: [],
        },
      ]),
    );
    render(<HookTrustBanner projectPath="/repo" />);
    await waitFor(() => expect(list).toHaveBeenCalledWith("/repo"));
    expect(screen.queryByTestId("hook-trust-banner")).toBeNull();
  });

  it("未评审时展开可见声明原文，批准后按 grant 提交并刷新", async () => {
    list.mockResolvedValueOnce(PENDING).mockResolvedValue(
      snapshot([
        {
          pluginId: "x@project",
          pluginName: "x",
          pluginRoot: "/repo/.sati/plugins/x",
          status: "trusted",
          hooks: [],
        },
      ]),
    );
    decide.mockResolvedValue({ applied: true });

    render(<HookTrustBanner projectPath="/repo" />);
    expect(await screen.findByTestId("hook-trust-banner")).toBeTruthy();
    expect(screen.getByText("subtitle:1")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "expand" }));
    expect(screen.getByText(/PreToolUse command: npx prettier --write \$FILE/u)).toBeTruthy();

    fireEvent.click(screen.getByTestId("hook-trust-approve-x@project"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("/repo", "x@project", "grant"));
    // 批准后重新取数 → 没有待处理条目 → 横幅消失。
    await waitFor(() => expect(screen.queryByTestId("hook-trust-banner")).toBeNull());
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("拒绝走 revoke，并把拒绝后的状态呈现为「已拒绝」", async () => {
    list.mockResolvedValueOnce(PENDING).mockResolvedValue(
      snapshot([
        {
          pluginId: "x@project",
          pluginName: "x",
          pluginRoot: "/repo/.sati/plugins/x",
          status: "revoked",
          hooks: [{ event: "PreToolUse", kind: "command", summary: "npx prettier --write $FILE" }],
        },
      ]),
    );
    decide.mockResolvedValue({ applied: true });

    render(<HookTrustBanner projectPath="/repo" />);
    fireEvent.click(await screen.findByRole("button", { name: "expand" }));
    fireEvent.click(screen.getByTestId("hook-trust-reject-x@project"));
    await waitFor(() => expect(decide).toHaveBeenCalledWith("/repo", "x@project", "revoke"));
    expect(await screen.findByText("status.revoked")).toBeTruthy();
  });

  it("没有项目路径时不发请求", async () => {
    render(<HookTrustBanner projectPath={null} />);
    await waitFor(() => expect(screen.queryByTestId("hook-trust-banner")).toBeNull());
    expect(list).not.toHaveBeenCalled();
  });

  it("请求失败时不渲染横幅（后端未接线不应打扰用户）", async () => {
    list.mockRejectedValue(new Error("boom"));
    render(<HookTrustBanner projectPath="/repo" />);
    await waitFor(() => expect(list).toHaveBeenCalled());
    expect(screen.queryByTestId("hook-trust-banner")).toBeNull();
  });
});
