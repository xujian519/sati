// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingPermissionRequest } from "../../types/types";
import PermissionRequestsBanner from "./PermissionRequestsBanner";

afterEach(() => {
  cleanup();
});

function request(overrides: Partial<PendingPermissionRequest> = {}): PendingPermissionRequest {
  return {
    requestId: "req-1",
    toolName: "bash",
    input: { command: "rm -rf build" },
    sessionId: "web/session-1",
    receivedAt: new Date(),
    ...overrides,
  };
}

const subagentOrigin = { kind: "subagent", subagentId: "fork-1", subagentType: "general-purpose" };

function renderBanner(requests: PendingPermissionRequest[]) {
  return render(
    <PermissionRequestsBanner
      pendingPermissionRequests={requests}
      handlePermissionDecision={() => {}}
      handleGrantToolPermission={() => ({ success: true })}
    />,
  );
}

describe("PermissionRequestsBanner（授权横幅的发起者归属）", () => {
  it("无挂起请求时返回 null", () => {
    const { container } = renderBanner([]);
    expect(container.firstChild).toBeNull();
  });

  it("主代理自身的请求不显示来源行", () => {
    renderBanner([request()]);
    expect(screen.getByText("permissionBanner.title")).toBeTruthy();
    expect(screen.queryByText("permissionBanner.subagentOrigin")).toBeNull();
  });

  it("子代理请求显示来源行（标注哪一次 fork 在请求）", () => {
    renderBanner([request({ origin: subagentOrigin })]);
    expect(screen.getByText("permissionBanner.subagentOrigin")).toBeTruthy();
  });

  it("归属不同的同工具请求不合并成一张卡片", () => {
    renderBanner([request({ requestId: "req-parent" }), request({ requestId: "req-child", origin: subagentOrigin })]);
    // 两条独立卡片：各自一条工具行，子代理那条带来源行。
    expect(screen.getAllByText("permissionBanner.title")).toHaveLength(2);
    expect(screen.getAllByText("permissionBanner.subagentOrigin")).toHaveLength(1);
  });

  it("同一子代理的重复请求仍合并为一张卡片", () => {
    renderBanner([
      request({ requestId: "req-child-1", origin: subagentOrigin }),
      request({ requestId: "req-child-2", origin: subagentOrigin }),
    ]);
    expect(screen.getAllByText("permissionBanner.titleCount")).toHaveLength(1);
    expect(screen.getAllByText("permissionBanner.subagentOrigin")).toHaveLength(1);
  });
});
