// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PendingApproval } from "../../types/types";
import ApprovalRequestsBanner from "./ApprovalRequestsBanner";

afterEach(() => {
  cleanup();
});

const pending: PendingApproval = {
  pendingIndex: 3,
  textPreview: "经检索对比，权利要求 1 具备新颖性……",
  triggerKeyword: "无效",
  sessionId: "web/test-session",
  createdAt: 1720000000000,
  receivedAt: new Date(),
};

describe("ApprovalRequestsBanner（输出门禁 HITL 审批卡片）", () => {
  it("无挂起审批时返回 null", () => {
    const { container } = render(<ApprovalRequestsBanner pendingApprovals={[]} handleApprovalDecision={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("显示挂起审批标题、触发词与消息预览", () => {
    render(<ApprovalRequestsBanner pendingApprovals={[pending]} handleApprovalDecision={() => {}} />);
    expect(screen.getByText("approvalBanner.title")).toBeTruthy();
    expect(screen.getByText("approvalBanner.trigger")).toBeTruthy();
    expect(screen.getByText("无效")).toBeTruthy();
    // 消息预览默认折叠，展开后可见。
    const summary = screen.getByText("approvalBanner.viewMessage").closest("summary");
    expect(summary).not.toBeNull();
    fireEvent.click(summary as HTMLElement);
    expect(screen.getByText(pending.textPreview)).toBeTruthy();
  });

  it("点击通过 → handleApprovalDecision(approval, 'adopted')", () => {
    const onDecide = vi.fn();
    render(<ApprovalRequestsBanner pendingApprovals={[pending]} handleApprovalDecision={onDecide} />);
    fireEvent.click(screen.getByText("approvalBanner.approve"));
    expect(onDecide).toHaveBeenCalledWith(pending, "adopted");
  });

  it("输入拒绝理由后点击拒绝 → handleApprovalDecision(approval, 'rejected', feedback)", () => {
    const onDecide = vi.fn();
    render(<ApprovalRequestsBanner pendingApprovals={[pending]} handleApprovalDecision={onDecide} />);
    fireEvent.change(screen.getByPlaceholderText("approvalBanner.feedbackPlaceholder"), {
      target: { value: "结论依据不足，需补充对比文件" },
    });
    fireEvent.click(screen.getByText("approvalBanner.reject"));
    expect(onDecide).toHaveBeenCalledWith(pending, "rejected", "结论依据不足，需补充对比文件");
  });

  it("无理由直接拒绝 → feedback 为 undefined", () => {
    const onDecide = vi.fn();
    render(<ApprovalRequestsBanner pendingApprovals={[pending]} handleApprovalDecision={onDecide} />);
    fireEvent.click(screen.getByText("approvalBanner.reject"));
    expect(onDecide).toHaveBeenCalledWith(pending, "rejected", undefined);
  });
});
