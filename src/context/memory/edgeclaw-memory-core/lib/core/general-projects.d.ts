import type { WorkspaceMemoryMode } from "./types.js";
export declare const GENERAL_PROJECT_META_DIR = "GeneralProjects";
export declare const GENERAL_PROJECT_MEMORY_DIR = "Project";
export declare const GENERAL_FEEDBACK_MEMORY_DIR = "Feedback";
export declare const GENERAL_WORKSPACE_DIR: string;
/**
 * Pre-rebrand workspace root. Existing external/general workspaces created
 * under `~/.pilotdeck` must keep resolving to general mode after an upgrade,
 * otherwise their project memory silently falls back to single-workspace
 * mode and previously retrievable records stop matching.
 */
export declare const LEGACY_GENERAL_WORKSPACE_DIR: string;
export declare const EXTERNAL_RECORD_PREFIX: "external:";
export declare const EXTERNAL_PROJECT_PREFIX: "external-project:";
export declare function normalizeWorkspacePath(workspacePath: string): string;
export declare function isGeneralWorkspaceDir(workspaceDir: string): boolean;
export declare function getWorkspaceMemoryMode(workspaceDir: string): WorkspaceMemoryMode;
export declare function buildExternalProjectLogicalId(workspacePath: string, projectId: string): string;
export declare function buildExternalRecordId(workspacePath: string, relativePath: string): string;
export declare function parseExternalRecordId(value: string): {
    workspaceKey: string;
    relativePath: string;
} | null;
export declare function isExternalRecordId(value: string): boolean;
