import { useRef, useState, useCallback, useEffect } from "react";

const LONG_TEXT_PUBLISH_THRESHOLD = 4000;
const PUBLISH_INTERVAL_MS = 50;

/**
 * Progressively reveals text with adaptive speed.
 * - When lag is large (burst arrival), renders fast to catch up
 * - When nearly caught up, renders at a smooth readable pace
 * - When not streaming (e.g. after refresh), shows full text immediately
 */
export function useTypewriter(fullText: string, isStreaming: boolean, baseCharsPerFrame = 3): string {
  const [displayLen, setDisplayLen] = useState(() => (isStreaming ? 0 : fullText.length));
  const rafRef = useRef<number | null>(null);
  const targetLenRef = useRef(fullText.length);
  const baseCharsRef = useRef(baseCharsPerFrame);
  const publishedAtRef = useRef(0);

  targetLenRef.current = fullText.length;
  baseCharsRef.current = baseCharsPerFrame;

  const pump = useCallback(() => {
    rafRef.current = null;
    setDisplayLen(prev => {
      const target = targetLenRef.current;
      if (prev >= target) return prev;

      // Adaptive speed: faster when far behind, slower when nearly caught up
      const lag = target - prev;
      let chars: number;
      if (lag > 200) {
        chars = Math.ceil(lag * 0.15); // Catch up fast: ~15% of lag per frame
      } else if (lag > 50) {
        chars = Math.ceil(lag * 0.1); // Medium speed
      } else {
        chars = baseCharsRef.current; // Normal speed when nearly caught up
      }

      const next = Math.min(prev + chars, target);
      rafRef.current = requestAnimationFrame(pump);
      // 长文每帧重新解析 Markdown 会挤占键盘/指针响应：>4000 字符时最多 50ms 发布一次，
      // 短文保持原有动画节奏，追平目标的那一帧必刷（返回 prev 时 React 跳过重渲染）。
      const now = performance.now();
      if (
        target < LONG_TEXT_PUBLISH_THRESHOLD ||
        next >= target ||
        now - publishedAtRef.current >= PUBLISH_INTERVAL_MS
      ) {
        publishedAtRef.current = now;
        return next;
      }
      return prev;
    });
  }, []);

  // Kick-start pump whenever new text arrives and pump is idle
  useEffect(() => {
    if (!isStreaming) {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setDisplayLen(fullText.length);
      return;
    }
    if (rafRef.current === null && fullText.length > 0) {
      rafRef.current = requestAnimationFrame(pump);
    }
  }, [isStreaming, fullText.length, pump]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  if (!isStreaming) return fullText;
  return fullText.slice(0, displayLen);
}
