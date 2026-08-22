import { useMemo } from "react";
import type { SessionGraphEdge, SessionGraphNode as NodeType } from "../types";
import { SessionGraphNode } from "./SessionGraphNode";

export type SessionGraphViewportProps = {
  nodes: NodeType[];
  edges: SessionGraphEdge[];
  viewport: { x: number; y: number; scale: number };
  containerRef: React.RefObject<SVGSVGElement | null>;
  handlers: {
    onWheel: (event: React.WheelEvent<SVGSVGElement>) => void;
    onPointerDown: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerMove: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerUp: (event: React.PointerEvent<SVGSVGElement>) => void;
    onPointerLeave: (event: React.PointerEvent<SVGSVGElement>) => void;
  };
  selectedNodeId?: string;
  onNodeMove?: (sessionId: string, delta: { x: number; y: number }, done: boolean) => void;
  onNodeClick?: (node: NodeType) => void;
};

export function SessionGraphViewport({
  nodes,
  edges,
  viewport,
  containerRef,
  handlers,
  selectedNodeId,
  onNodeMove,
  onNodeClick,
}: SessionGraphViewportProps) {
  const transform = useMemo(
    () => `translate(${viewport.x}, ${viewport.y}) scale(${viewport.scale})`,
    [viewport.x, viewport.y, viewport.scale],
  );

  return (
    <svg
      ref={containerRef}
      data-session-graph-canvas
      className="h-full w-full touch-none"
      style={{ touchAction: "none" }}
      {...handlers}
    >
      <g transform={transform}>
        {edges.map(edge => {
          const fromNode = nodes.find(n => n.sessionId === edge.from);
          const toNode = nodes.find(n => n.sessionId === edge.to);
          if (!fromNode || !toNode) return null;
          return (
            <line
              key={`${edge.from}-${edge.to}`}
              x1={fromNode.position.x + 220 / 2}
              y1={fromNode.position.y + 96}
              x2={toNode.position.x + 220 / 2}
              y2={toNode.position.y}
              stroke="currentColor"
              strokeOpacity={0.35}
              strokeWidth={1.5}
              className="text-neutral-400"
            />
          );
        })}
        {nodes.map(node => (
          <SessionGraphNode
            key={node.sessionId}
            node={node}
            selected={node.sessionId === selectedNodeId}
            onMove={onNodeMove}
            onClick={onNodeClick}
          />
        ))}
      </g>
    </svg>
  );
}
