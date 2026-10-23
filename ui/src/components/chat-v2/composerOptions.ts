import { Bot, CircleHelp, Hand, ListChecks, ShieldAlert, type LucideIcon } from "lucide-react";
import type { ChatRunMode, PermissionMode } from "../chat/types/types";

export type PermissionModeOption = {
  mode: PermissionMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
  descriptionKey: string;
  defaultDescription: string;
};

export const PERMISSION_MODE_OPTIONS: PermissionModeOption[] = [
  {
    mode: "default",
    Icon: Hand,
    labelKey: "input.permissions.default",
    defaultLabel: "Default Permissions",
    descriptionKey: "input.permissions.defaultDescription",
    defaultDescription: "Ask before risky operations",
  },
  {
    mode: "bypassPermissions",
    Icon: ShieldAlert,
    labelKey: "input.permissions.bypassPermissions",
    defaultLabel: "Full Access",
    descriptionKey: "input.permissions.bypassPermissionsDescription",
    defaultDescription: "Skip confirmations and allow full access",
  },
];

export type RunModeOption = {
  mode: ChatRunMode;
  Icon: LucideIcon;
  labelKey: string;
  defaultLabel: string;
};

export const RUN_MODE_OPTIONS: RunModeOption[] = [
  {
    mode: "agent",
    Icon: Bot,
    labelKey: "input.runModes.agent",
    defaultLabel: "Agent",
  },
  {
    mode: "plan",
    Icon: ListChecks,
    labelKey: "input.runModes.plan",
    defaultLabel: "Plan",
  },
  {
    mode: "ask",
    Icon: CircleHelp,
    labelKey: "input.runModes.ask",
    defaultLabel: "Ask",
  },
];

export const BLOCKING_PERMISSION_TOOLS = new Set([
  "AskUserQuestion",
  "ExitPlanMode",
  "ExitPlanModeV2",
  "exit_plan_mode",
]);
