import { createElement, type ComponentType, type ReactNode } from "react";

export type ToolbarIconProps = {
  className?: string;
  strokeWidth?: number;
};

export function renderToolbarIcon(Icon: unknown): ReactNode {
  return createElement(Icon as ComponentType<ToolbarIconProps>, {
    className: "h-4 w-4",
    strokeWidth: 1.75,
  });
}
