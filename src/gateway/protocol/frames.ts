import type { GatewayEvent, GatewayServerInfo } from "./types.js";

export type GatewayWsClientName = "cli" | "tui" | "web" | "feishu" | "test";

export type WsHelloFrame = {
  type: "hello";
  protocolVersion: string;
  clientName: GatewayWsClientName;
  clientVersion: string;
  token: string;
};

export type WsHelloOk = {
  type: "hello_ok";
  protocolVersion: string;
  serverVersion: string;
  serverInfo: GatewayServerInfo;
};

export type WsGatewayMethod =
  | "submit_turn"
  | "abort_turn"
  | "list_sessions"
  | "resume_session"
  | "new_session"
  | "close_session"
  | "record_agent_status_message"
  | "describe_server"
  | "active_turn_snapshot"
  | "cron_create"
  | "cron_update"
  | "cron_list"
  | "cron_delete"
  | "cron_stop"
  | "cron_run_now"
  | "elicitation_respond"
  | "permission_decide"
  | "grant_session_permission"
  | "approval_list_pending"
  | "approval_decide"
  | "read_session_messages"
  | "read_subagent_messages"
  | "fork_session"
  | "list_projects"
  | "describe_project"
  | "reload_config"
  | "prepare_weixin_login"
  | "reload_extensions"
  | "skill_list"
  | "skill_read"
  | "skill_write"
  | "skill_create"
  | "skill_delete"
  | "skill_import"
  | "skill_validate"
  | "skill_scan"
  | "always_on_apply"
  | "always_on_rerun_plan"
  | "always_on_list_plans"
  | "always_on_read_report"
  | "always_on_list_cycles"
  | "always_on_archive_cycle"
  | "always_on_apply_cycle"
  | "knowledge_capabilities"
  | "panel_heartbeat"
  | "team_panel_snapshot"
  | "team_tool_call"
  | "kanban_get"
  | "kanban_add_card"
  | "kanban_update_card"
  | "kanban_move_card"
  | "kanban_archive_card"
  | "kanban_restore_card"
  | "kanban_purge_card"
  | "kanban_bulk_archive_cards"
  | "kanban_bulk_move_cards"
  | "kanban_duplicate_card"
  | "kanban_move_card_to_project"
  | "kanban_add_column"
  | "kanban_rename_column"
  | "kanban_delete_column"
  | "kanban_reorder_columns"
  | "kanban_undo"
  | "kanban_subscribe"
  | "kanban_unsubscribe";

export type WsRequestFrame = {
  type: "request";
  id: string;
  method: WsGatewayMethod;
  params: unknown;
};

export type WsResponseFrame =
  | {
      type: "response";
      id: string;
      ok: true;
      result: unknown;
    }
  | {
      type: "response";
      id: string;
      ok: false;
      error: { code: string; message: string };
    };

export type WsEventFrame = {
  type: "event";
  id: string;
  seq: number;
  final: boolean;
  event: GatewayEvent;
};

/**
 * Server-pushed notification (no request id). Sent after `hello_ok` to
 * inform connected clients about asynchronous state changes (e.g. a
 * config reload triggered by a file-system watcher or another client).
 */
export type WsNotificationFrame = {
  type: "notification";
  name: string;
  payload?: unknown;
};

export type WsGatewayFrame =
  | WsHelloFrame
  | WsHelloOk
  | WsRequestFrame
  | WsResponseFrame
  | WsEventFrame
  | WsNotificationFrame;
