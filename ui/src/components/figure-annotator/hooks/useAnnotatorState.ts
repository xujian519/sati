/**
 * 标注器的编辑状态：绘制模式/工具/颜色、标注集合与撤销重做、当前选中、总体说明。
 *
 * 撤销栈与"当前标注"合并在一个 state 里（三个字段一起更新），不用"在 setState 的更新函数里
 * 再调 setState"的写法——那种写法在 React StrictMode 的双调用下会重复入栈。
 * 说明文字的编辑**不入撤销栈**（逐字入栈会让撤销变成退格键），与参考实现一致。
 */
import { useCallback, useState } from "react";
import type { FigureAnnotationMark } from "../../../types/annotationReference";
import { MARK_HISTORY_LIMIT, type AnnotatorTool } from "../constants/annotator";
import { ANNOTATOR_COLORS } from "../constants/annotator";

type History = {
  past: readonly (readonly FigureAnnotationMark[])[];
  present: readonly FigureAnnotationMark[];
  future: readonly (readonly FigureAnnotationMark[])[];
};

/** 标注器可编辑状态。 */
export type AnnotatorState = {
  mode: "view" | "annotate";
  setMode: (mode: "view" | "annotate") => void;
  tool: AnnotatorTool;
  setTool: (tool: AnnotatorTool) => void;
  color: string;
  setColor: (color: string) => void;
  marks: readonly FigureAnnotationMark[];
  selectedId: string | null;
  setSelectedId: (id: string | null) => void;
  summary: string;
  setSummary: (summary: string) => void;
  /** 已在盘上的那份文档的创建时间（覆盖保存时保持首存时间）。 */
  createdAt: string | null;
  addMark: (mark: FigureAnnotationMark) => void;
  removeMark: (id: string) => void;
  updateMarkText: (id: string, text: string) => void;
  clearMarks: () => void;
  undo: () => void;
  redo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  /** 载入一份已保存的标注（原件状态，不进撤销栈）。 */
  seed: (document: { marks: readonly FigureAnnotationMark[]; summary?: string; createdAt: string }) => void;
  /** 记下这次保存的时间（覆盖保存时保持首存时间）。 */
  markSaved: (createdAt: string) => void;
};

/** 标注 id 生成器（会话内单调，够用且不依赖 crypto.randomUUID）。 */
let markSequence = 0;

/** 生成一个文档内唯一的标注 id。 */
export function nextMarkId(): string {
  markSequence += 1;
  return `m${Date.now().toString(36)}-${markSequence}`;
}

/** 标注器的编辑状态。 */
export function useAnnotatorState(): AnnotatorState {
  const [mode, setMode] = useState<"view" | "annotate">("view");
  const [tool, setTool] = useState<AnnotatorTool>("arrow");
  const [color, setColor] = useState<string>(ANNOTATOR_COLORS[0]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [summary, setSummary] = useState("");
  const [createdAt, setCreatedAt] = useState<string | null>(null);
  const [history, setHistory] = useState<History>({ past: [], present: [], future: [] });

  const commit = useCallback((next: readonly FigureAnnotationMark[]) => {
    setHistory(previous => ({
      past: [...previous.past, previous.present].slice(-MARK_HISTORY_LIMIT),
      present: next,
      future: [],
    }));
  }, []);

  const addMark = useCallback((mark: FigureAnnotationMark) => {
    setHistory(previous => ({
      past: [...previous.past, previous.present].slice(-MARK_HISTORY_LIMIT),
      present: [...previous.present, mark],
      future: [],
    }));
  }, []);

  const removeMark = useCallback(
    (id: string) => {
      commit(history.present.filter(mark => mark.id !== id));
      setSelectedId(current => (current === id ? null : current));
    },
    [commit, history.present],
  );

  const updateMarkText = useCallback((id: string, text: string) => {
    setHistory(previous => ({
      ...previous,
      present: previous.present.map(mark => (mark.id === id ? { ...mark, text } : mark)),
    }));
  }, []);

  const clearMarks = useCallback(() => {
    commit([]);
    setSelectedId(null);
  }, [commit]);

  const undo = useCallback(() => {
    setHistory(previous => {
      const restored = previous.past[previous.past.length - 1];
      if (restored === undefined) return previous;
      return {
        past: previous.past.slice(0, -1),
        present: restored,
        future: [previous.present, ...previous.future].slice(0, MARK_HISTORY_LIMIT),
      };
    });
  }, []);

  const redo = useCallback(() => {
    setHistory(previous => {
      const restored = previous.future[0];
      if (restored === undefined) return previous;
      return {
        past: [...previous.past, previous.present].slice(-MARK_HISTORY_LIMIT),
        present: restored,
        future: previous.future.slice(1),
      };
    });
  }, []);

  const seed = useCallback(
    (document: { marks: readonly FigureAnnotationMark[]; summary?: string; createdAt: string }) => {
      setHistory({ past: [], present: [...document.marks], future: [] });
      setSummary(document.summary ?? "");
      setCreatedAt(document.createdAt);
      setSelectedId(null);
      if (document.marks.length > 0) setMode("annotate");
    },
    [],
  );

  const markSaved = useCallback((savedAt: string) => {
    setCreatedAt(current => current ?? savedAt);
  }, []);

  return {
    mode,
    setMode,
    tool,
    setTool,
    color,
    setColor,
    marks: history.present,
    selectedId,
    setSelectedId,
    summary,
    setSummary,
    createdAt,
    addMark,
    removeMark,
    updateMarkText,
    clearMarks,
    undo,
    redo,
    canUndo: history.past.length > 0,
    canRedo: history.future.length > 0,
    seed,
    markSaved,
  };
}
