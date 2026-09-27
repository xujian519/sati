// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FigureAnnotationMark } from "../../../types/annotationReference";
import { useAnnotationSubmit } from "./useAnnotationSubmit";

const saveFigureAnnotation = vi.fn();
vi.mock("../utils/sidecar", () => ({
  saveFigureAnnotation: (...args: unknown[]) => saveFigureAnnotation(...args) as Promise<string>,
  readFigureAnnotation: () => Promise.resolve(null),
}));

const marks: readonly FigureAnnotationMark[] = [
  {
    id: "m1",
    kind: "arrow",
    color: "#e03131",
    points: [
      [0, 0],
      [10, 10],
    ],
    text: "这个标号指错了",
  },
];

/** 记录调用键的翻译器（键应为命名空间下的短键）。 */
function translator(): { t: (key: string, options?: { path?: string }) => string; keys: string[] } {
  const keys: string[] = [];
  return {
    keys,
    t: (key: string, options?: { path?: string }) => {
      keys.push(key);
      return options?.path === undefined ? `t:${key}` : `t:${key}:${options.path}`;
    },
  };
}

function harness(overrides: Record<string, unknown> = {}) {
  const { t, keys } = translator();
  const onSaved = vi.fn();
  const hook = renderHook(() =>
    useAnnotationSubmit({
      projectName: "demo",
      figurePath: "/w/project/figures/inv-fig1.svg",
      relativePath: "figures/inv-fig1.svg",
      fileName: "inv-fig1.svg",
      mimeType: "image/svg+xml",
      size: { width: 416, height: 141 },
      sha256: "c".repeat(64),
      layer: undefined,
      marks,
      summary: "把标号都对齐一遍",
      createdAt: null,
      t,
      onSaved,
      ...overrides,
    }),
  );
  return { hook, keys, onSaved };
}

beforeEach(() => {
  saveFigureAnnotation.mockReset();
  saveFigureAnnotation.mockResolvedValue("/w/project/figures/inv-fig1.annot.json");
});

describe("annotation submit", () => {
  it("saves the sidecar and reports it with the namespaced short keys", async () => {
    const { hook, keys, onSaved } = harness();

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(saveFigureAnnotation).toHaveBeenCalledTimes(1);
    const [projectName, figurePath, document] = saveFigureAnnotation.mock.calls[0] as [
      string,
      string,
      { marks: unknown[]; createdAt: string },
    ];
    expect(projectName).toBe("demo");
    expect(figurePath).toBe("/w/project/figures/inv-fig1.svg");
    expect(document.marks).toHaveLength(1);
    // 短键：全键会被视图注入的前缀再次前缀化，界面上就会显示键名而不是文案。
    expect(keys).toEqual(["saving", "saved"]);
    expect(hook.result.current.status).toEqual({
      tone: "ok",
      text: "t:saved:/w/project/figures/inv-fig1.annot.json",
    });
    expect(onSaved).toHaveBeenCalledWith(document.createdAt);
    expect(hook.result.current.busy).toBeNull();
  });

  it("does nothing without a mark and never calls the server", async () => {
    const { hook } = harness({ marks: [] });
    await act(async () => {
      await hook.result.current.run(true);
    });
    expect(saveFigureAnnotation).not.toHaveBeenCalled();
    expect(hook.result.current.status).toBeNull();
  });

  it("surfaces a save failure instead of dropping the annotation silently", async () => {
    saveFigureAnnotation.mockRejectedValue(new Error("EACCES"));
    const { hook } = harness();

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(hook.result.current.status).toEqual({ tone: "error", text: "t:failedEACCES" });
    expect(hook.result.current.busy).toBeNull();
  });

  it("refuses to send before the figure geometry is known", async () => {
    const { hook, keys } = harness({ size: undefined, sha256: undefined });

    await act(async () => {
      await hook.result.current.run(false);
    });

    expect(saveFigureAnnotation).not.toHaveBeenCalled();
    // 失败提示由「前缀 + notReady 原因」拼成，故 failed 也会被取用。
    expect(keys).toEqual(["saving", "notReady", "failed"]);
    expect(hook.result.current.status?.tone).toBe("error");
  });
});
