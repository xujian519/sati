// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnnotationMark } from "../../../types/annotationReference";
import { useAnnotatorState } from "./useAnnotatorState";

function mark(id: string, text = ""): AnnotationMark {
  return {
    id,
    kind: "arrow",
    color: "#e03131",
    points: [
      [0, 0],
      [10, 10],
    ],
    text,
  };
}

describe("annotator state", () => {
  it("commits marks and walks the history backwards and forwards", () => {
    const { result } = renderHook(() => useAnnotatorState());

    act(() => result.current.addMark(mark("m1")));
    act(() => result.current.addMark(mark("m2")));
    expect(result.current.marks.map(item => item.id)).toEqual(["m1", "m2"]);
    expect(result.current.canUndo).toBe(true);

    act(() => result.current.undo());
    expect(result.current.marks.map(item => item.id)).toEqual(["m1"]);
    expect(result.current.canRedo).toBe(true);

    act(() => result.current.redo());
    expect(result.current.marks.map(item => item.id)).toEqual(["m1", "m2"]);

    act(() => result.current.undo());
    act(() => result.current.addMark(mark("m3")));
    // 新的编辑动作截断重做栈。
    expect(result.current.canRedo).toBe(false);
    expect(result.current.marks.map(item => item.id)).toEqual(["m1", "m3"]);
  });

  it("drops the selection when the selected mark is removed", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.addMark(mark("m1")));
    act(() => result.current.setSelectedId("m1"));
    act(() => result.current.removeMark("m1"));
    expect(result.current.marks).toEqual([]);
    expect(result.current.selectedId).toBeNull();
  });

  it("clears every mark and can undo that too", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.addMark(mark("m1")));
    act(() => result.current.clearMarks());
    expect(result.current.marks).toEqual([]);
    act(() => result.current.undo());
    expect(result.current.marks.map(item => item.id)).toEqual(["m1"]);
  });

  it("edits note text without touching the history", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.addMark(mark("m1")));
    const before = result.current.canUndo;
    act(() => result.current.updateMarkText("m1", "这个标号指错了"));
    expect(result.current.marks[0]?.text).toBe("这个标号指错了");
    expect(result.current.canUndo).toBe(before);
  });

  it("seeds a saved annotation as the new baseline, switching to annotate mode", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.addMark(mark("m1")));

    act(() =>
      result.current.seed({
        marks: [mark("s1", "保存过的说明")],
        summary: "把标号都对齐一遍",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    expect(result.current.marks.map(item => item.id)).toEqual(["s1"]);
    expect(result.current.summary).toBe("把标号都对齐一遍");
    expect(result.current.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.current.mode).toBe("annotate");
    // 灌入的是基线，不是一步编辑。
    expect(result.current.canUndo).toBe(false);
  });

  it("stamps the drawn-on figure baseline on new marks, and leaves seeded ones alone", () => {
    const { result } = renderHook(() => useAnnotatorState({ targetFingerprint: "sha256:new" }));
    act(() => result.current.addMark(mark("m1")));
    expect(result.current.marks[0]?.targetFingerprint).toBe("sha256:new");

    act(() =>
      result.current.seed({
        marks: [mark("s1"), { ...mark("s2"), targetFingerprint: "sha256:old" }],
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    // 载入的标注保留自己的基线：它画在哪一版图上不是本次会话能改写的。
    expect(result.current.marks.map(item => item.targetFingerprint)).toEqual([undefined, "sha256:old"]);
  });

  it("adds no baseline before the figure hash is known", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.addMark(mark("m1")));
    expect(result.current.marks[0]).not.toHaveProperty("targetFingerprint");
  });

  it("flags the state as touched by any edit, and clears the flag when seeded", () => {
    const { result } = renderHook(() => useAnnotatorState());
    expect(result.current.touched).toBe(false);

    act(() => result.current.addMark(mark("m1")));
    expect(result.current.touched).toBe(true);

    act(() => result.current.updateMarkText("m1", "改说明"));
    expect(result.current.touched).toBe(true);

    act(() => result.current.clearMarks());
    expect(result.current.touched).toBe(true);

    act(() => result.current.addMark(mark("m2")));
    act(() => result.current.removeMark("m2"));
    expect(result.current.touched).toBe(true);

    // 灌入已保存的标注是基线，不是一步编辑：读回完成后才允许下一次灌入。
    act(() => result.current.seed({ marks: [mark("s1")], createdAt: "2026-01-01T00:00:00.000Z" }));
    expect(result.current.touched).toBe(false);
  });

  it("keeps the first save time across later saves", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.markSaved("2026-01-01T00:00:00.000Z"));
    act(() => result.current.markSaved("2026-02-02T00:00:00.000Z"));
    expect(result.current.createdAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("stays in view mode when a saved figure carries no mark", () => {
    const { result } = renderHook(() => useAnnotatorState());
    act(() => result.current.seed({ marks: [], createdAt: "2026-01-01T00:00:00.000Z" }));
    expect(result.current.mode).toBe("view");
  });
});
