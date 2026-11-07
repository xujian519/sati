// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextStatusPopover } from "./ContextStatusPopover";
import { getContextStatus } from "./contextStatus";

const t = ((_key: string, options?: Record<string, unknown>) => options?.defaultValue ?? _key) as never;

afterEach(cleanup);

describe("ContextStatusPopover", () => {
  it("提供入口并回调打开检查器", () => {
    const onInspectContext = vi.fn();
    render(
      <ContextStatusPopover
        status={getContextStatus({ used: 100, total: 1000 })}
        title="Context window"
        t={t}
        modelContext={{ sessionId: "session-1" }}
        onInspectContext={onInspectContext}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Inspect context" }));
    expect(onInspectContext).toHaveBeenCalledTimes(1);
  });

  it("缺少会话定位参数时不显示入口", () => {
    render(
      <ContextStatusPopover
        status={getContextStatus({ used: 100, total: 1000 })}
        title="Context window"
        t={t}
        onInspectContext={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: "Inspect context" })).toBeNull();
  });
});
