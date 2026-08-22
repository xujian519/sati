import React, { useCallback, useRef, useState } from "react";
import type { SessionGraphNode as NodeType } from "../types";

const NODE_WIDTH = 220;
const NODE_HEIGHT = 96;

function truncate(text: string, maxChars: number) {
  return text.length > maxChars ? text.slice(0, maxChars) + "…" : text;
}

export type SessionGraphNodeProps = {
  node: NodeType;
  selected?: boolean;
  onMove?: (sessionId: string, delta: { x: number; y: number }, done: boolean) => void;
  onClick?: (node: NodeType) => void;
};

function SessionGraphNodeRaw({ node, selected, onMove, onClick }: SessionGraphNodeProps) {
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef<{ x: number; y: number } | null>(null);
  const [isHovered, setIsHovered] = useState(false);

  const handlePointerDown = useCallback((event: React.PointerEvent<SVGElement>) => {
    event.stopPropagation();
    isDraggingRef.current = false;
    dragStartRef.current = { x: event.clientX, y: event.clientY };
    (event.target as Element).closest("[data-session-node]")?.setPointerCapture?.(event.pointerId);
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
        onMove?.(node.sessionId, { x: dx, y: dy }, false);
        dragStartRef.current = { x: event.clientX, y: event.clientY };
      }
    },
    [node.sessionId, onMove],
  );

  const handlePointerUp = useCallback(
    (event: React.PointerEvent<SVGElement>) => {
      (event.target as Element).closest("[data-session-node]")?.releasePointerCapture?.(event.pointerId);
      if (dragStartRef.current == null) return;
      const dx = event.clientX - dragStartRef.current.x;
      const dy = event.clientY - dragStartRef.current.y;
      if (isDraggingRef.current) {
        onMove?.(node.sessionId, { x: dx, y: dy }, true);
      } else if (onClick) {
        onClick(node);
      }
      dragStartRef.current = null;
      isDraggingRef.current = false;
    },
    [node, onClick, onMove],
  );

  return (
    <g
      data-session-node={node.sessionId}
      transform={`translate(${node.position.x}, ${node.position.y})`}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      className="cursor-pointer"
      style={{ touchAction: "none" }}
    >
      <rect
        width={NODE_WIDTH}
        height={NODE_HEIGHT}
        rx={8}
        ry={8}
        className={`transition-colors ${isHovered ? "fill-neutral-50 dark:fill-neutral-800" : "fill-white dark:fill-neutral-900"}`}
        stroke={selected ? "#0ea5e9" : node.color || "#e5e5e5"}
        strokeWidth={selected ? 3 : isHovered ? 2 : 1}
      />
      <text x={12} y={22} fontSize={13} fontWeight={500} fill="#171717">
        {truncate(node.title || "Untitled", 24)}
      </text>
      {node.forkPreview ? (
        <text x={12} y={44} fontSize={11} fill="#737373">
          {truncate("fork: " + node.forkPreview.questionSnippet, 32)}
        </text>
      ) : null}
      <circle cx={18} cy={NODE_HEIGHT - 16} r={4} fill={node.status === "processing" ? "#f59e0b" : "#22c55e"} />
      <text x={28} y={NODE_HEIGHT - 12} fontSize={11} fill="#a3a3a3">
        {node.status}
      </text>
    </g>
  );
}

export const SessionGraphNode = React.memo(SessionGraphNodeRaw);
