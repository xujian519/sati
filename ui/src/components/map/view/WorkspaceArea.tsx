import type { MapThread, MapWorkspace } from "../types";
import { computeWorkspaceHeight, WORKSPACE_AREA_WIDTH } from "../utils/layout";

type WorkspaceAreaProps = {
  workspace: MapWorkspace;
  threads: MapThread[];
};

export function WorkspaceArea({ workspace, threads }: WorkspaceAreaProps) {
  const height = computeWorkspaceHeight(workspace.id, threads);
  return (
    <g data-map-workspace={workspace.id} transform={`translate(${workspace.position.x}, ${workspace.position.y})`}>
      <rect
        width={WORKSPACE_AREA_WIDTH}
        height={height}
        rx={12}
        ry={12}
        fill={workspace.color}
        fillOpacity={0.06}
        stroke={workspace.color}
        strokeOpacity={0.25}
        strokeWidth={1.5}
        strokeDasharray="6 4"
      />
      <text x={16} y={24} className="text-[13px] font-semibold select-none" style={{ fill: workspace.color }}>
        {workspace.name}
      </text>
    </g>
  );
}
