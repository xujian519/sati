import { useCallback, useEffect, useRef, useState } from "react";
import type React from "react";
import { isImeEnterEvent } from "../../../../../utils/ime";
import type { PermissionPanelProps } from "../../configs/permissionPanelRegistry";
import type { Question } from "../../../types/types";

/**
 * AskUserQuestion 面板的状态与交互：当前步骤、选项/自定义回答、提交与键盘路由。
 *
 * 从 `AskUserQuestionPanel.tsx` 搬出（#646 B2.5），**被搬代码逐字未改**；
 * 组件只保留派生展示值与 JSX，渲染路径未改。
 */

type QuestionPanelOptions = Pick<PermissionPanelProps, "request" | "onDecision"> & {
  questions: Question[];
};

export function useQuestionPanel({ request, onDecision, questions }: QuestionPanelOptions) {
  const input = request.input as { questions?: unknown } | undefined;

  const [currentStep, setCurrentStep] = useState(0);
  const [selections, setSelections] = useState<Map<number, Set<string>>>(() => new Map());
  const [otherTexts, setOtherTexts] = useState<Map<number, string>>(() => new Map());
  const [otherActive, setOtherActive] = useState<Map<number, boolean>>(() => new Map());
  const [mounted, setMounted] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const otherInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  // Focus the container for keyboard events when step changes
  useEffect(() => {
    if (!otherActive.get(currentStep)) {
      containerRef.current?.focus();
    }
  }, [currentStep, otherActive]);

  useEffect(() => {
    if (otherActive.get(currentStep)) {
      otherInputRef.current?.focus();
    }
  }, [otherActive, currentStep]);

  const toggleOption = useCallback((qIdx: number, label: string, multiSelect: boolean) => {
    setSelections(prev => {
      const next = new Map(prev);
      const current = new Set(next.get(qIdx) || []);
      if (multiSelect) {
        if (current.has(label)) current.delete(label);
        else current.add(label);
      } else {
        current.clear();
        current.add(label);
        setOtherActive(p => {
          const n = new Map(p);
          n.set(qIdx, false);
          return n;
        });
      }
      next.set(qIdx, current);
      return next;
    });
  }, []);

  const toggleOther = useCallback((qIdx: number, multiSelect: boolean) => {
    setOtherActive(prev => {
      const next = new Map(prev);
      const wasActive = next.get(qIdx) || false;
      next.set(qIdx, !wasActive);
      if (!multiSelect && !wasActive) {
        setSelections(p => {
          const n = new Map(p);
          n.set(qIdx, new Set());
          return n;
        });
      }
      return next;
    });
  }, []);

  const setOtherText = useCallback((qIdx: number, text: string) => {
    setOtherTexts(prev => {
      const next = new Map(prev);
      next.set(qIdx, text);
      return next;
    });
  }, []);

  const buildAnswers = useCallback(() => {
    const answers: Record<string, string> = {};
    questions.forEach((q, idx) => {
      const selected = Array.from(selections.get(idx) || []);
      const isOther = otherActive.get(idx) || false;
      const otherText = (otherTexts.get(idx) || "").trim();
      if (isOther && otherText) selected.push(otherText);
      if (selected.length > 0) answers[q.question] = selected.join(", ");
    });
    return answers;
  }, [questions, selections, otherActive, otherTexts]);

  const handleSubmit = useCallback(() => {
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: buildAnswers() } });
  }, [onDecision, request.requestId, input, buildAnswers]);

  const handleSkip = useCallback(() => {
    onDecision(request.requestId, { allow: true, updatedInput: { ...input, answers: {} } });
  }, [onDecision, request.requestId, input]);

  // Keyboard handler for number keys and navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Don't capture keys when typing in the "Other" input
      if (e.target instanceof HTMLInputElement) return;

      const q = questions[currentStep];
      if (!q) return;
      const multi = q.multiSelect || false;
      const optCount = q.options.length;

      // Number keys 1-9 for options
      const num = parseInt(e.key);
      if (!isNaN(num) && num >= 1 && num <= optCount) {
        e.preventDefault();
        toggleOption(currentStep, q.options[num - 1].label, multi);
        return;
      }

      // 0 for "Other"
      if (e.key === "0") {
        e.preventDefault();
        toggleOther(currentStep, multi);
        return;
      }

      // Enter to advance / submit
      if (e.key === "Enter") {
        if (isImeEnterEvent(e)) {
          return;
        }
        e.preventDefault();
        const isLast = currentStep === questions.length - 1;
        if (isLast) handleSubmit();
        else setCurrentStep(s => s + 1);
        return;
      }

      // Escape to skip
      if (e.key === "Escape") {
        e.preventDefault();
        handleSkip();
        return;
      }
    },
    [currentStep, questions, toggleOption, toggleOther, handleSubmit, handleSkip],
  );

  return {
    currentStep,
    setCurrentStep,
    selections,
    otherTexts,
    otherActive,
    mounted,
    containerRef,
    otherInputRef,
    toggleOption,
    toggleOther,
    setOtherText,
    buildAnswers,
    handleSubmit,
    handleSkip,
    handleKeyDown,
  };
}
