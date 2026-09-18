// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MessagesPanePlaceholder, resolveMessagesPanePlaceholder } from "./MessagesPanePlaceholder";

/**
 * 会话区占位视图测试（#159 N03b）。
 *
 * 这五个分支原先内联在 `MessagesPaneV2` 的 JSX 三元链里——**优先级只由书写顺序表达**，
 * 改一处顺序就可能让"加载失败"被"空会话"盖住，而且完全没有测试。搬出时把判定抽成纯函数
 * `resolveMessagesPanePlaceholder`，于是优先级可以被直接钉住。JSX 的搬迁本身由
 * `/tmp/n03b-move-proof.mjs` 的五块逐 token 比对兜底。
 *
 * 说明：测试环境不初始化 i18n，`t(key, { defaultValue })` 会回落到默认英文文案——断言用的就是它。
 */

const base = {
  hasSessionLoadError: false,
  isLoadingSessionMessages: false,
  messageCount: 10,
  isNewConversationEmpty: false,
  isExistingConversationEmpty: false,
  isForkedSession: false,
};

describe("resolveMessagesPanePlaceholder", () => {
  it("都不成立时返回 null（应当渲染消息列表）", () => {
    expect(resolveMessagesPanePlaceholder(base)).toBeNull();
  });

  it("加载失败优先级最高，压过空会话与加载中", () => {
    expect(
      resolveMessagesPanePlaceholder({
        ...base,
        hasSessionLoadError: true,
        isLoadingSessionMessages: true,
        messageCount: 0,
        isNewConversationEmpty: true,
        isExistingConversationEmpty: true,
      }),
    ).toBe("session-load-error");
  });

  it("加载中只在确实没有消息时占位", () => {
    expect(resolveMessagesPanePlaceholder({ ...base, isLoadingSessionMessages: true, messageCount: 0 })).toBe(
      "loading",
    );
    // 已有消息时不应盖住列表
    expect(resolveMessagesPanePlaceholder({ ...base, isLoadingSessionMessages: true, messageCount: 3 })).toBeNull();
  });

  it("新会话空态压过已存在会话空态", () => {
    expect(
      resolveMessagesPanePlaceholder({ ...base, isNewConversationEmpty: true, isExistingConversationEmpty: true }),
    ).toBe("new-conversation");
  });

  it("已存在但无可见消息时按是否分支会话区分两种空态", () => {
    expect(resolveMessagesPanePlaceholder({ ...base, isExistingConversationEmpty: true, isForkedSession: true })).toBe(
      "fork-empty",
    );
    expect(resolveMessagesPanePlaceholder({ ...base, isExistingConversationEmpty: true, isForkedSession: false })).toBe(
      "empty-session",
    );
  });

  it("加载失败时不再落到任何空态（避免与错误提示互相矛盾）", () => {
    expect(
      resolveMessagesPanePlaceholder({ ...base, hasSessionLoadError: true, isExistingConversationEmpty: true }),
    ).toBe("session-load-error");
  });
});

describe("MessagesPanePlaceholder", () => {
  afterEach(() => cleanup());

  it("新会话空态渲染建议提示词，点击回填输入框", () => {
    const setInput = vi.fn();
    render(
      <MessagesPanePlaceholder
        kind="new-conversation"
        selectedProject={{ name: "p1", displayName: "P1", fullPath: "/p1" }}
        suggestedPrompts={["提示一", "提示二"]}
        setInput={setInput}
        sessionIsReadOnly={false}
      />,
    );

    expect(screen.getByText("Start a new conversation")).toBeTruthy();
    fireEvent.click(screen.getByText("提示二"));
    expect(setInput).toHaveBeenCalledWith("提示二");
  });

  it("没有选中项目时新会话空态提示去侧栏选项目，且不渲染提示词", () => {
    render(
      <MessagesPanePlaceholder
        kind="new-conversation"
        selectedProject={null}
        suggestedPrompts={["提示一"]}
        setInput={vi.fn()}
        sessionIsReadOnly={false}
      />,
    );

    expect(screen.getByText("Pick a project from the sidebar")).toBeTruthy();
    expect(screen.queryByText("提示一")).toBeNull();
  });

  it("分支会话空态：标题与说明按 fork 文案渲染", () => {
    render(
      <MessagesPanePlaceholder
        kind="fork-empty"
        selectedSession={{ id: "s1", parentSessionId: "parent-1" } as never}
        forkParentSessionTitle="我之前的会话"
        suggestedPrompts={[]}
        setInput={vi.fn()}
        sessionIsReadOnly={false}
      />,
    );

    expect(screen.getByText("New branch ready")).toBeTruthy();
    // 测试环境无 i18n ⇒ 落到 defaultValue；`{{parent}}` 只在真实语言包里做插值，
    // 所以这里断言的是"分支说明文案出现在页面上"，父标题插值由 locale 覆盖。
    expect(screen.getByText(/This branch starts from the beginning of the original conversation/)).toBeTruthy();
  });

  it("加载失败态渲染错误文本，重试按钮走回调", () => {
    const onRetrySessionLoad = vi.fn();
    render(
      <MessagesPanePlaceholder
        kind="session-load-error"
        sessionLoadError="读取会话失败：EOF"
        onRetrySessionLoad={onRetrySessionLoad}
        suggestedPrompts={[]}
        setInput={vi.fn()}
        sessionIsReadOnly={false}
      />,
    );

    expect(screen.getByText("读取会话失败：EOF")).toBeTruthy();
    fireEvent.click(screen.getByText("Retry"));
    expect(onRetrySessionLoad).toHaveBeenCalledTimes(1);
  });

  it("只读会话空态用只读文案（与普通空会话区分）", () => {
    render(<MessagesPanePlaceholder kind="empty-session" suggestedPrompts={[]} setInput={vi.fn()} sessionIsReadOnly />);

    expect(screen.getByText("No displayable messages in this read-only transcript")).toBeTruthy();
  });
});
