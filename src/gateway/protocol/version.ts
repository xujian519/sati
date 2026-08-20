/**
 * Gateway protocol version.
 *
 * Semantics: MAJOR.MINOR
 *   - MAJOR: breaking changes (frame structure, incompatible method
 *     semantics, removed/renamed methods, breaking event fields).
 *   - MINOR: backward-compatible additions (new optional methods, new
 *     event types, widened optional inputs).
 *
 * New optional methods must stay feature-detectable: clients check
 * availability (e.g. via `describe_server` / `not_configured` results)
 * and never assume an older peer implements them.
 *
 * Change log:
 *   - 1.0 — initial protocol (hello, submit_turn, sessions, cron, skills, always_on_apply/rerun).
 *   - 1.1 — 2026-08-05: added optional discovery-plan methods
 *           always_on_list_plans / always_on_read_report / always_on_list_cycles /
 *           always_on_archive_cycle / always_on_apply_cycle.
 *   - 1.2 — 2026-08-11: added optional output-gate HITL approval methods
 *           approval_list_pending / approval_decide + `approval_pending` /
 *           `approval_resolved` event types.
 *   - 1.3 — 2026-08-13: added optional cron task update method `cron_update`.
 *           (2026-08-14: `cron_update` response tightened to
 *           `{updated:true;task}|{updated:false;reason:"not_found"|"running"|"conflict"}`
 *           union; `projectKey` and `expectedRevision` inputs required.)
 *   - 1.4 — 2026-08-20: added optional team-activity-panel methods
 *           `panel_heartbeat` (browser activity heartbeat →
 *           SessionPresence.panelTouch, M4 Web 下线判定) /
 *           `team_panel_snapshot` / `team_tool_call` (MINOR，feature-detect)。
 */
export const SATI_GATEWAY_PROTOCOL_VERSION = "1.4";

/**
 * Handshake compatibility check: clients and servers with the same MAJOR
 * version may connect; MINOR differences only mean capability differences
 * (optional methods are feature-detected, never assumed).
 *
 * `SATI_GATEWAY_PROTOCOL_VERSION_WEB` ("1.0") is a browser-friendly mirror
 * with an identical frame shape — same MAJOR, so Web clients are accepted.
 */
export function isProtocolCompatible(clientVersion: string, serverVersion: string): boolean {
  const clientMajor = clientVersion.split(".")[0];
  const serverMajor = serverVersion.split(".")[0];
  return clientMajor !== "" && clientMajor === serverMajor;
}
