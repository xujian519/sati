import React, { useMemo } from "react";
import type { MapEdge, MapThread, MapWorkspace } from "../types";
import { MapCard } from "./MapCard";
import { WorkspaceArea } from "./WorkspaceArea";

export type MapCanvasProps = {
  workspaces: MapWorkspace[];
  threads: MapThread[];
  edges: MapEdge[];
  viewport: { x: number; y: number; scale: number };
  containerRef: React.RefObject<SVGSVGElement | null>;
  handlers: {
    onWheel: (event: React.WheelEvent<SVGSVGElement>) => void;
    onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: (event: React.PointerEvent<SVGSVGElement>) => void;
  };
  selectedThreadId?: string;
  onThreadMove?: (threadId: string, delta: { x: number; y: number }, done: boolean) => void;
  onThreadClick?: (thread: MapThread) => void;
};

export function MapCanvas({
  workspaces,
  threads,
  edges,
  viewport,
  containerRef,
  handlers,
  selectedThreadId,
  onThreadMove,
  onThreadClick,
}: MapCanvasProps) {
  const transform = useMemo(
    () => `translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`,
    [viewport.x, viewport.y, viewport.scale],
  );

  return (
    <svg
      ref={containerRef}
      data-map-canvas
      className="h-full w-full touch-none"
      style={{ touchAction: "none" }}
      {...handlers}
    >
      <g transform={transform}>
        {workspaces.map(workspace => (
          <WorkspaceArea key={workspace.id} workspace={workspace} threads={threads} />
        ))}
        {edges.map(edge => {
          const fromThread = threads.find(t => t.id === edge.from);
          const toThread = threads.find(t => t.id === edge.to);
          if (!fromThread || !toThread) return null;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={fromThread.position.x + 220 / 2}
              y1={fromThread.position.y + 80}
              x2={toThread.position.x + 220 / 2}
              y2={toThread.position.y}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1.5}
              className="text-neutral-400"
            />
          );
        })}
        {threads.map(thread => (
          <MapCard
            key={thread.id}
            thread={thread}
            selected={thread.id === selectedThreadId}
            onMove={onThreadMove}
            onClick={onThreadClick}
          />
        ))}
      </g>
    </svg>
  );
}
