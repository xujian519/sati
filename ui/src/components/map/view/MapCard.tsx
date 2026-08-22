import React, { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { MapThread } from "../types";

export const CARD_WIDTH = 220;
export const CARD_HEIGHT = 80;

function truncate(text: string, maxChars: number) {
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

export type MapCardProps = {
  thread: MapThread;
  selected?: boolean;
  onMove?: (threadId: string, delta: { x: number; y: number }, done: boolean) => void;
  onClick?: (thread: MapThread) => void;
};

function MapCardRaw({ thread, selected, onMove, onClick }: MapCardProps) {
  const { t } = useTranslation("map");
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGElement>) => {
    event.stopPropagation();
    isDraggingRef.current = false;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    (event.target as Element).closest("[data-map-card]")?.setPointerCapture?.(event.pointerId);
  }, []);

  const handlePointerMove = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      if (dragStartRef.current == null) return;
      const dx = event.clientX - dragStartRef.current.x;
      const dy = event.clientY - dragStartRef.current.y;
      if (!isDraggingRef.current && Math.hypot(dx, dy) > 3) {
        isDraggingRef.current = true;
      }
      if (isDraggingRef.current) {
        onMove?.(thread.id, { x: dx, y: dy }, false);
        dragStartRef.current = { x: event.clientX, y: event.clientY };
      }
    },
    [thread.id, onMove],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      (event.target as Element).closest("[data-map-card]")?.releasePointerCapture?.(event.pointerId);
      if (dragStartRef.current == null) return;
      const dx = event.clientX - dragStartRef.current.x;
      const dy = event.clientY - dragStartRef.current.y;
      if (isDraggingRef.current) {
        onMove?.(thread.id, { x: dx, y: dy }, true);
      } else if (onClick) {
        onClick(thread);
      }
      dragStartRef.current = null;
      isDraggingRef.current = false;
    },
    [thread, onClick, onMove],
  );

  const statusDot =
    thread.status === "processing" ? "bg-amber-400" : thread.status === "interrupted" ? "bg-red-400" : "bg-emerald-400";

  return (
    <g
      data-map-card={thread.id}
      data-map-thread={thread.id}
      transform={`translate(${thread.position.x}, ${thread.position.y})`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="cursor-pointer"
      style={{ touchAction: "none" }}
    >
      <rect
        width={CARD_WIDTH}
        height={CARD_HEIGHT}
        rx={8}
        ry={8}
        className={`transition-colors ${isHovered ? "fill-neutral-50 dark:fill-neutral-800" : "fill-white dark:fill-neutral-900"}`}
        stroke={selected ? "#0ea5e9" : thread.color || "#e5e5e5"}
        strokeWidth={selected ? 2.5 : 1.5}
      />
      <rect x={0} y={0} width={6} height={CARD_HEIGHT} rx={3} ry={3} fill={thread.color || "#e5e5e5"} />
      <text x={16} y={28} className="text-[13px] font-medium select-none" style={{ fill: "currentColor" }}>
        {truncate(thread.title, 26)}
      </text>
      <circle cx={22} cy={56} r={4} className={statusDot} />
      <text
        x={34}
        y={60}
        className="text-[11px] capitalize select-none"
        style={{ fill: "currentColor" }}
        opacity={0.65}
      >
        {t(`status.${thread.status}`, { defaultValue: thread.status })}
      </text>
    </g>
  );
}

export const MapCard = React.memo(MapCardRaw);
