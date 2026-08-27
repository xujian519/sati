/**
 * WS 请求参数守卫表（TD-GATEWAY-002 待做半 + TD-GATEWAY-006 穷尽检查）。
 *
 * `frame.params` 来自线上 JSON.parse，到达这里前只经过 isRequestFrame 的
 * frame 外形检查。本表在分发进 Gateway 实现之前做一次**边界收窄**：
 *
 * - 每个方法都必须在表中登记（`satisfies Record<WsGatewayMethod, ParamSpec>`），
 *   新增 union 成员而漏登会在编译期报错，消除「switch 漏 case 即静默失败」的税；
 * - 声明了必填字段的条目会校验存在性与基础类型；未声明的键不校验（向前兼容，
 *   gateway 方法内部对自身契约负责，这里只堵「畸形入参直穿」这一层）。
 *
 * 守卫原则：**服务端永不因「多余数据」拒绝**——M3 约定任意帧可携带杂散
 * sessionKey 用于在线态刷新，故未声明字段一律放行，仅对声明的必填字段做
 * 存在性与基础类型收窄。
 *
 * 口径：字段级规格以 `Gateway` 接口签名与各域 Input 类型为唯一事实源
 * （submit/list/new/abort/close 见 protocol/types.ts；kanban 族见
 * gateway/kanban/types.ts）。尚未逐字段精确化的命名类型条目用 OBJECT_PARAMS
 * （仅要求 object-or-undefined），后续按域逐步收紧。
 */
import type { WsGatewayMethod } from "../protocol/frames.js";

export type ParamFieldKind =
  | "string"
  | "string?"
  | "number"
  | "number?"
  | "boolean"
  | "boolean?"
  | "string[]"
  | "record"
  | "unknown";

export type ParamSpec = {
  /** 字段契约；可选字段带 `?` 后缀。未声明的键不做任何校验。 */
  fields?: Record<string, ParamFieldKind>;
};

/** 仅要求 params 为普通对象或省略——保守基线，后续按域替换为精确 fields。 */
export const OBJECT_PARAMS: ParamSpec = {};

function fields(spec: Record<string, ParamFieldKind>): ParamSpec {
  return { fields: spec };
}

const KIND_CHECKS: Record<ParamFieldKind, (v: unknown) => boolean> = {
  string: v => typeof v === "string",
  "string?": v => v === undefined || typeof v === "string",
  number: v => typeof v === "number" && Number.isFinite(v),
  "number?": v => v === undefined || (typeof v === "number" && Number.isFinite(v)),
  boolean: v => typeof v === "boolean",
  "boolean?": v => v === undefined || typeof v === "boolean",
  "string[]": v => Array.isArray(v) && v.every(x => typeof x === "string"),
  record: v => typeof v === "object" && v !== null && !Array.isArray(v),
  unknown: () => true,
};

/** 校验单个方法的 params；返回错误描述，null 表示通过。 */
export function validateMethodParamValue(method: WsGatewayMethod, spec: ParamSpec, params: unknown): string | null {
  if (!spec.fields) {
    // OBJECT_PARAMS：对象或省略皆可。
    if (params === undefined || params === null) return null;
    if (typeof params !== "object" || Array.isArray(params)) return `${method}: params must be an object`;
    return null;
  }
  const requiredKinds = Object.entries(spec.fields).filter(([, k]) => !k.endsWith("?"));
  if (requiredKinds.length > 0 && (params === undefined || params === null)) {
    return `${method}: missing required param${requiredKinds.length > 1 ? "s" : ""} ${requiredKinds.map(([k]) => k).join(", ")}`;
  }
  if (params === undefined || params === null) return null;
  if (typeof params !== "object" || Array.isArray(params)) {
    return `${method}: params must be an object`;
  }
  const rec = params as Record<string, unknown>;
  for (const [key, kind] of Object.entries(spec.fields)) {
    const check = KIND_CHECKS[kind];
    if (!check(rec[key])) {
      if (rec[key] === undefined && kind.endsWith("?")) continue;
      const label = kind.endsWith("?") ? kind.slice(0, -1) : kind;
      return `${method}: param ${key} must be ${label}`;
    }
  }
  return null;
}

/**
 * 全方法守卫表。穷尽性由 `satisfies Record<WsGatewayMethod, ParamSpec>` 保证：
 * 新增 WsGatewayMethod 成员而未在此登记时 typecheck 直接失败。
 */
export const METHOD_PARAM_GUARDS = {
  submit_turn: fields({ sessionKey: "string", channelKey: "string", message: "string" }),
  abort_turn: fields({ sessionKey: "string" }),
  list_sessions: fields({ projectKey: "string?", limit: "number?", cursor: "string?" }),
  resume_session: fields({ sessionKey: "string" }),
  new_session: fields({ channelKey: "string" }),
  close_session: fields({ sessionKey: "string" }),
  record_agent_status_message: OBJECT_PARAMS,
  describe_server: OBJECT_PARAMS,
  active_turn_snapshot: fields({ sessionKey: "string?" }),
  cron_create: OBJECT_PARAMS,
  cron_update: OBJECT_PARAMS,
  cron_list: OBJECT_PARAMS,
  cron_delete: OBJECT_PARAMS,
  cron_stop: OBJECT_PARAMS,
  cron_run_now: OBJECT_PARAMS,
  elicitation_respond: OBJECT_PARAMS,
  permission_decide: OBJECT_PARAMS,
  grant_session_permission: OBJECT_PARAMS,
  approval_list_pending: OBJECT_PARAMS,
  approval_decide: OBJECT_PARAMS,
  read_session_messages: OBJECT_PARAMS,
  read_subagent_messages: OBJECT_PARAMS,
  fork_session: OBJECT_PARAMS,
  list_projects: OBJECT_PARAMS,
  describe_project: OBJECT_PARAMS,
  reload_config: OBJECT_PARAMS,
  prepare_weixin_login: OBJECT_PARAMS,
  reload_extensions: OBJECT_PARAMS,
  skill_list: OBJECT_PARAMS,
  skill_read: OBJECT_PARAMS,
  skill_write: OBJECT_PARAMS,
  skill_create: OBJECT_PARAMS,
  skill_delete: OBJECT_PARAMS,
  skill_import: OBJECT_PARAMS,
  skill_validate: OBJECT_PARAMS,
  skill_scan: OBJECT_PARAMS,
  always_on_apply: OBJECT_PARAMS,
  always_on_rerun_plan: OBJECT_PARAMS,
  always_on_list_plans: OBJECT_PARAMS,
  always_on_read_report: OBJECT_PARAMS,
  always_on_list_cycles: OBJECT_PARAMS,
  always_on_archive_cycle: OBJECT_PARAMS,
  always_on_apply_cycle: OBJECT_PARAMS,
  knowledge_capabilities: OBJECT_PARAMS,
  panel_heartbeat: fields({ sessionKeys: "string[]" }),
  team_panel_snapshot: fields({ sessionKey: "string?" }),
  team_tool_call: fields({ tool: "string", input: "record", sessionKey: "string?" }),

  kanban_get: fields({ projectKey: "string", includeArchived: "boolean?" }),
  kanban_add_card: fields({ projectKey: "string", columnId: "string", title: "string" }),
  kanban_update_card: fields({ projectKey: "string", cardId: "string" }),
  kanban_move_card: fields({ projectKey: "string", cardId: "string", columnId: "string" }),
  kanban_archive_card: fields({ projectKey: "string", cardId: "string" }),
  kanban_restore_card: fields({ projectKey: "string", cardId: "string" }),
  kanban_purge_card: fields({ projectKey: "string", cardId: "string" }),
  kanban_bulk_archive_cards: fields({ projectKey: "string", ids: "string[]" }),
  kanban_bulk_move_cards: fields({ projectKey: "string", ids: "string[]", columnId: "string" }),
  kanban_duplicate_card: fields({ projectKey: "string", cardId: "string" }),
  kanban_move_card_to_project: fields({ projectKey: "string", cardId: "string", toProjectKey: "string" }),
  kanban_add_column: fields({ projectKey: "string", title: "string" }),
  kanban_rename_column: fields({ projectKey: "string", columnId: "string", title: "string" }),
  kanban_delete_column: fields({ projectKey: "string", columnId: "string" }),
  kanban_reorder_columns: fields({ projectKey: "string", columnIds: "string[]" }),
  kanban_undo: fields({ projectKey: "string" }),
  kanban_subscribe: fields({ projectId: "string" }),
  kanban_unsubscribe: fields({ projectId: "string" }),
} satisfies Record<WsGatewayMethod, ParamSpec>;

/** 分发入口用的总校验器；返回首条违规描述，通过时返回 null。 */
export function validateMethodParams(method: WsGatewayMethod, params: unknown): string | null {
  const guard = (METHOD_PARAM_GUARDS as Record<string, ParamSpec | undefined>)[method];
  if (!guard) {
    // 编译期穷尽性由 satisfies 保证；运行期到达这里的未知方法（理论上不可达）
    // 放行给分发器 default 分支，维持既有 gateway_request_failed 契约。
    return null;
  }
  return validateMethodParamValue(method, guard, params);
}
