/**
 * Web UI dual parity scenario registry.
 *
 * Each scenario MUST declare a status. The `web-ui/parity-scenarios.test.ts`
 * test enforces:
 *   - unique scenarioId
 *   - status ∈ {"compare", "intentional_difference", "deferred", "not_applicable"}
 *   - non-`compare` status MUST include `reason`
 *
 * See `docs/old-ui-adaptation/04-implementation-plan/02-web-ui-parity-test-guide.md`.
 */

export type WebUiParityStatus =
  | "compare"
  | "intentional_difference"
  | "deferred"
  | "not_applicable";

export type WebUiParityScenario = {
  scenarioId: string;
  title: string;
  status: WebUiParityStatus;
  /** Phase the scenario belongs to (0..5). */
  phase: 0 | 1 | 2 | 3 | 4 | 5;
  /** REQUIRED for non-`compare` statuses. */
  reason?: string;
  /** Where to look for the implementation in src + ui. */
  surfaces?: string[];
};

export const WEB_UI_PARITY_SCENARIOS: WebUiParityScenario[] = [
  {
    scenarioId: "project-list-basic",
    title: "List projects with stable identifiers",
    status: "compare",
    phase: 3,
    surfaces: ["src/adapters/web/projects.ts", "ui/src/features/projects"],
  },
  {
    scenarioId: "session-list-basic",
    title: "List sessions for a project",
    status: "compare",
    phase: 1,
    surfaces: ["src/gateway/protocol/types.ts", "ui/src/gateway"],
  },
  {
    scenarioId: "session-history-text-only",
    title: "Restore a text-only assistant turn from transcript",
    status: "compare",
    phase: 2,
    surfaces: ["src/session/web/readSessionMessages.ts"],
  },
  {
    scenarioId: "session-history-tool-call",
    title: "Restore a turn containing a tool call + result",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "submit-turn-text-stream",
    title: "Stream assistant_text_delta and merge into a single assistant message",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "submit-turn-tool-call",
    title: "Stream tool_call_started + tool_call_finished pairing",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "submit-turn-error",
    title: "Surface recoverable / non-recoverable error events",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "abort-turn",
    title: "abort_turn collapses stream into final status",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "permission-request-allow",
    title: "permission_request → permission_decide(allow) closes the loop",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "permission-request-deny",
    title: "permission_request → permission_decide(deny) records denial",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "history-pagination",
    title: "Paginate session history with cursor / offset",
    status: "compare",
    phase: 2,
  },
  {
    scenarioId: "background-task-session",
    title: "Background-task sessions render separately from chat sessions",
    status: "compare",
    phase: 3,
  },
  {
    scenarioId: "file-tree-basic",
    title: "Read project file tree under workspace root",
    status: "compare",
    phase: 4,
  },
  {
    scenarioId: "file-read-text",
    title: "Read text file content",
    status: "compare",
    phase: 4,
  },
  {
    scenarioId: "file-write-text",
    title: "Write text file content with workspace boundary",
    status: "compare",
    phase: 4,
  },
  {
    scenarioId: "file-binary-metadata",
    title: "Surface metadata for binary file without dumping bytes",
    status: "compare",
    phase: 4,
  },
  {
    scenarioId: "git-status-basic",
    title: "Read structured git status",
    status: "compare",
    phase: 4,
  },
  {
    scenarioId: "git-diff-basic",
    title: "Read structured git diff for a single path",
    status: "compare",
    phase: 4,
  },
  {
    scenarioId: "cron-list-create-delete",
    title: "Cron list/create/delete via gateway methods",
    status: "compare",
    phase: 5,
  },

  // Deferred -----------------------------------------------------------------

  {
    scenarioId: "shell-pty-session",
    title: "xterm + node-pty interactive shell",
    status: "deferred",
    phase: 5,
    reason:
      "Old `/shell` WS + node-pty maps to a future Gateway terminal extension. UI shows 'Shell coming soon' until terminal_open / terminal_input / terminal_resize / terminal_close land in src/gateway.",
  },
  {
    scenarioId: "cron-run-now-history-log",
    title: "Cron run-now / run history / run log",
    status: "deferred",
    phase: 5,
    reason:
      "src/cron + src/always-on do not yet expose per-task run history / log readers. UI lists tasks but disables history/log buttons until the gateway methods land.",
  },
  {
    scenarioId: "always-on-discovery",
    title: "Always-On discovery + plans + run association",
    status: "deferred",
    phase: 5,
    reason:
      "Discovery management surface needs a stable Gateway contract. UI surfaces a status banner and links to docs until then.",
  },
  {
    scenarioId: "memory-dashboard",
    title: "Memory dashboard / memory API",
    status: "deferred",
    phase: 5,
    reason:
      "PilotDeck memory/context API is still under design (see docs/rewrite-plan/02-rewrite-project-report.md §347-349). UI hides the entry behind feature flag.",
  },
  {
    scenarioId: "skills-management",
    title: "Skills + commands management",
    status: "deferred",
    phase: 5,
    reason:
      "src/extension contributions are read-only via Gateway today. UI lists skills as read-only; install/enable disabled.",
  },
  {
    scenarioId: "plugins-management",
    title: "Plugin install / enable / disable",
    status: "deferred",
    phase: 5,
    reason:
      "Plugin proxy + security review pending. UI lists plugins read-only and links to CLI for management.",
  },
  {
    scenarioId: "mcp-management",
    title: "MCP server registration + per-server tools",
    status: "deferred",
    phase: 5,
    reason:
      "MCP write-side (add/remove servers) requires permission + config schema work. UI shows current MCP tools read-only.",
  },

  // Intentional differences --------------------------------------------------

  {
    scenarioId: "auth-local-token",
    title: "Auth via /auth/local-token instead of legacy JWT",
    status: "intentional_difference",
    phase: 1,
    reason:
      "GatewayServer is localhost-bound and issues a per-process token via /auth/local-token. Legacy JWT/local auth not migrated; non-localhost binding intentionally unsupported in phase 1.",
  },
  {
    scenarioId: "session-key-format",
    title: "sessionKey replaces provider-native session ids",
    status: "intentional_difference",
    phase: 2,
    reason:
      "PilotDeck session router uses sessionKey (channel:project:uuid). Old provider-native ids are mapped via fixtures; UI may surface both for back-compat reads but writes always use sessionKey.",
  },
  {
    scenarioId: "single-provider-runtime",
    title: "Single PilotDeck runtime instead of four-provider session storage",
    status: "intentional_difference",
    phase: 3,
    reason:
      "Old `cursorSessions/codexSessions/geminiSessions` collapse into a single PilotDeck session list. Old provider field preserved as metadata for legacy reads.",
  },

  // Not applicable -----------------------------------------------------------

  {
    scenarioId: "taskmaster",
    title: "TaskMaster panel",
    status: "not_applicable",
    phase: 5,
    reason:
      "Product decision documented in 04-parity-matrix.md. Re-open if PilotDeck reintroduces TaskMaster.",
  },
];

export function getWebUiScenario(id: string): WebUiParityScenario | undefined {
  return WEB_UI_PARITY_SCENARIOS.find((scenario) => scenario.scenarioId === id);
}
