import { useCallback, useRef, useState } from "react";

export type ViewportState = {
  x: number;
  y: number;
  scale: number;
};

const MIN_SCALE = 0.25;
const MAX_SCALE = 3;
const ZOOM_SENSITIVITY = 0.001;

export function useSessionGraphViewport(initialState?: Partial<ViewportState>) {
  const [viewport, setViewport] = useState<ViewportState>({
    x: initialState?.x ?? 0,
    y: initialState?.y ?? 0,
    scale: initialState?.scale ?? 1,
  });

  const containerRef = useRef<SVGSVGElement | null>(null);
  const isPanningRef = useRef(false);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number): { x: number; y: number } => {
      const svg = containerRef.current;
      if (!svg) return { x: screenX, y: screenY };
      const rect = svg.getBoundingClientRect();
      return {
        x: (screenX - rect.left - viewport.x) / viewport.scale,
        y: (screenY - rect.top - viewport.y) / viewport.scale,
      };
    },
    [viewport.x, viewport.y, viewport.scale],
  );

  const setTransform = useCallback((updater: (prev: ViewportState) => ViewportState) => {
    setViewport(prev => {
      const next = updater(prev);
      const clampedScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, next.scale));
      return { ...next, scale: clampedScale };
    });
  }, []);

  const handleWheel = useCallback(
    (event: React.WheelEvent<SVGSVGElement>) => {
      event.preventDefault();
      const svg = containerRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const mouseX = event.clientX - rect.left;
      const mouseY = event.clientY - rect.top;

      const delta = -event.deltaY * ZOOM_SENSITIVITY;
      const scaleFactor = Math.exp(delta);

      setTransform(prev => {
        const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, prev.scale * scaleFactor));
        const scaleRatio = newScale / prev.scale;
        const newX = mouseX - (mouseX - prev.x) * scaleRatio;
        const newY = mouseY - (mouseY - prev.y) * scaleRatio;
        return { x: newX, y: newY, scale: newScale };
      });
    },
    [setTransform],
  );

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (event.button !== 0) return;
    if ((event.target as Element).closest("[data-session-node]")) return;
    isPanningRef.current = true;
    lastPointerRef.current = { x: event.clientX, y: event.clientY };
    const svg = containerRef.current;
    svg?.setPointerCapture(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGSVGElement>) => {
      if (!isPanningRef.current || lastPointerRef.current == null) return;
      const dx = event.clientX - lastPointerRef.current.x;
      const dy = event.clientY - lastPointerRef.current.y;
      lastPointerRef.current = { x: event.clientX, y: event.clientY };
      setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
    },
    [setTransform],
  );

  const handlePointerUp = useCallback((event: React.PointerEvent<SVGSVGElement>) => {
    if (!isPanningRef.current) return;
    isPanningRef.current = false;
    lastPointerRef.current = null;
    const svg = containerRef.current;
    svg?.releasePointerCapture(event.pointerId);
  }, []);

  const resetViewport = useCallback(() => {
    setViewport({ x: 0, y: 0, scale: 1 });
  }, []);

  const fitToBounds = useCallback(
    (bounds: { minX: number; minY: number; maxX: number; maxY: number }, padding = 40) => {
      const svg = containerRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const contentWidth = bounds.maxX - bounds.minX + padding * 2;
      const contentHeight = bounds.maxY - bounds.minY + padding * 2;
      const scale = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Math.min(rect.width / contentWidth, rect.height / contentHeight)),
      );
      const x = rect.width / 2 - ((bounds.minX + bounds.maxX) / 2) * scale;
      const y = rect.height / 2 - ((bounds.minY + bounds.maxY) / 2) * scale;
      setViewport({ x, y, scale });
    },
    [],
  );

  return {
    containerRef,
    viewport,
    screenToCanvas,
    setTransform,
    resetViewport,
    fitToBounds,
    handlers: {
      onWheel: handleWheel,
      onPointerDown: handlePointerDown,
      onPointerMove: handlePointerMove,
      onPointerUp: handlePointerUp,
      onPointerLeave: handlePointerUp,
    },
  };
}
