/**
 * Gateway protocol version ledger.
 *
 * Semantics: MAJOR.MINOR
 *   - MAJOR: breaking changes (frame structure, incompatible method
 *     semantics, removed/renamed methods, breaking event fields).
 *   - MINOR: backward-compatible additions (new optional methods, new
 *     event types, widened optional inputs).
 *
 * New optional methods must stay feature-detectable: clients check
 * availability (e.g. via `describe_server` / `not_configured` results)
 * and never assume an older peer implements them. MINOR 因此只是**能力水位
 * 的下界**，不是「客户端可据以代替 feature-detect 的依据」。
 *
 * 本文件是「协议方法 → 首次对客户端可见的版本」的唯一事实源：
 *   - `PROTOCOL_METHOD_VERSION` 覆盖 `WsGatewayMethod` 的每个成员，由
 *     `satisfies Record<WsGatewayMethod, GatewayProtocolVersion>` 编译期把关
 *     （新增 union 成员而漏登 = typecheck 失败）；
 *   - `PROTOCOL_RELEASES` 是发布台账（逐版本的变更理由），**末条即当前版本**，
 *     `SATI_GATEWAY_PROTOCOL_VERSION` 由它派生 ⇒ bump 与登记不可能各改一处；
 *   - `pnpm check:protocol-version` 从 `frames.ts` 的 AST 重新提取 union 成员，
 *     与台账做**两向集合相等**断言，再跑 `protocolLedgerIssues` 校验版本连续性
 *     （与 `check:event-matrix` 同构，挂 `pnpm lint` 链尾）。
 *
 * 历史回溯口径（issue #362，2026-09-16）：本表落地之前的方法，其版本按**首次进入
 * `frames.ts` union 的提交时点**回溯当时 `SATI_GATEWAY_PROTOCOL_VERSION` 的取值；
 * 版本常量尚不存在时的一律归 1.0 基线。回溯点名到两处长期漏登记的方法——
 * `knowledge_capabilities`（1.1）与 `kanban_reorder_columns`（1.5），正是门禁要堵的形态。
 */
import type { WsGatewayMethod } from "./frames.js";

/** 发布台账条目形状（`as const` 之后用 `satisfies` 约束）。 */
type ProtocolReleaseEntry = {
  version: string;
  /** 该版本的变更说明（日期 + 理由）；保留原文语义，便于人类阅读。 */
  note: string;
  /** 无新方法的变更（事件类型 / 响应形状收紧）。有方法登记的版本留空。 */
  changes?: readonly string[];
};

/**
 * 协议发布台账，**按版本升序**，末条即当前版本。
 *
 * 只增不改：已发布条目的 `note`/`changes` 可以补正文字，但**不得搬动版本号**——
 * 搬动会让旧客户端对不存在的方法乐观发帧（正是 1.1/1.5 那两处漏登记的后果）。
 */
export const PROTOCOL_RELEASES = [
  {
    version: "1.0",
    note: "初版协议：提交与会话（submit_turn / abort_turn / list_sessions / resume_session / new_session / close_session / read_session_messages / read_subagent_messages / fork_session）、cron（create·list·delete·stop·run_now）、skills（list·read·write·create·delete·import·validate·scan）、always_on_apply·rerun_plan、describe_server / active_turn_snapshot / elicitation_respond / permission_decide / grant_session_permission / record_agent_status_message / list_projects / describe_project / reload_config / reload_extensions / prepare_weixin_login 等基线方法。",
  },
  {
    version: "1.1",
    note: "2026-08-05: 新增可选 discovery-plan 方法 always_on_list_plans / always_on_read_report / always_on_list_cycles / always_on_archive_cycle / always_on_apply_cycle；2026-08-06 追加 knowledge_capabilities（知识库运行时能力自检的 gateway 出口，原变更表漏登记）。",
  },
  {
    version: "1.2",
    note: "2026-08-11: 新增可选输出门禁 HITL 审批方法 approval_list_pending / approval_decide。",
    changes: ["新增 approval_pending / approval_resolved 事件类型。"],
  },
  {
    version: "1.3",
    note: "2026-08-13: 新增可选 cron 任务更新方法 cron_update。",
    changes: [
      '2026-08-14: cron_update 响应收紧为 {updated:true;task} | {updated:false;reason:"not_found"|"running"|"conflict"} 联合；projectKey 与 expectedRevision 入参转为必需。',
    ],
  },
  {
    version: "1.4",
    note: "2026-08-20: 新增可选 team-activity-panel 方法 panel_heartbeat（浏览器活跃心跳 → SessionPresence.panelTouch，M4 Web 下线判定）/ team_panel_snapshot / team_tool_call（MINOR，feature-detect）。",
  },
  {
    version: "1.5",
    note: "2026-08-26: 新增可选项目看板方法 kanban_get / kanban_add_card / kanban_update_card / kanban_move_card / kanban_archive_card / kanban_restore_card / kanban_purge_card / kanban_bulk_archive_cards / kanban_bulk_move_cards / kanban_duplicate_card / kanban_move_card_to_project / kanban_add_column / kanban_rename_column / kanban_delete_column / kanban_reorder_columns（同日 Phase 5.1「列拖拽排序」追加，原变更表漏登记）/ kanban_undo / kanban_subscribe / kanban_unsubscribe（MINOR，feature-detect）。",
    changes: ["新增 kanban_updated 通知事件。"],
  },
  {
    version: "1.6",
    note: "2026-09-04: 新增可选 mid-turn steering 方法 steer_turn / cancel_steer。",
    changes: ["新增 steer_applied / steer_unapplied 事件类型。", "active_turn_snapshot 响应新增可选 steerItems。"],
  },
  {
    version: "1.7",
    note: "2026-09-04: 新增可选 last-turn rewrite 方法 edit_last_turn / regenerate_last_turn（遮蔽式 append-only：追加 turn_rewrite 转录条目，投影层跳过被遮蔽条目；成功后由调用方走标准 submit_turn 重发）。",
  },
  {
    version: "1.8",
    note: "2026-09-10: 新增可选 project-lifecycle 方法 close_project_sessions（上游 #568 移植：项目删除前暂停新建、排空在跑 turn 与转录写入器；resume: true 解冻。未实现时服务端显式报错而非 not_configured 降级——删除方必须确知已排空）。",
  },
  {
    version: "1.9",
    note: "2026-09-16: 无新方法；active_turn_snapshot 响应新增可选 projection（上游 #593 移植：本 turn 内各通道的绝对文本投影，事件日志因上限截断丢掉的正文开头由它补齐）。",
    changes: [
      "active_turn_snapshot 响应新增可选 projection：{ runId, blocks: [{ kind, epoch, text, inflight? }] }。旧客户端忽略该字段即退回旧行为——正文只有截断后的事件流可用。",
    ],
  },
] as const satisfies readonly ProtocolReleaseEntry[];

/** 台账条目类型（含 `note` / `changes`）。 */
export type ProtocolRelease = (typeof PROTOCOL_RELEASES)[number];

/** 协议版本号字面量；由台账派生，新增 MINOR 只需加一条 release。 */
export type GatewayProtocolVersion = ProtocolRelease["version"];

/**
 * 方法 → 首次对客户端可见的协议版本。
 *
 * 漏登/多登都不可能静默：`satisfies Record<WsGatewayMethod, ...>` 双向把关
 * （缺键 = typecheck 失败；台账里出现 union 之外的方法名 = 多余属性检查失败），
 * `pnpm check:protocol-version` 再用 AST 复核一遍。
 */
export const PROTOCOL_METHOD_VERSION = {
  // 1.0 基线
  submit_turn: "1.0",
  abort_turn: "1.0",
  list_sessions: "1.0",
  resume_session: "1.0",
  new_session: "1.0",
  close_session: "1.0",
  record_agent_status_message: "1.0",
  describe_server: "1.0",
  active_turn_snapshot: "1.0",
  cron_create: "1.0",
  cron_list: "1.0",
  cron_delete: "1.0",
  cron_stop: "1.0",
  cron_run_now: "1.0",
  elicitation_respond: "1.0",
  permission_decide: "1.0",
  grant_session_permission: "1.0",
  read_session_messages: "1.0",
  read_subagent_messages: "1.0",
  fork_session: "1.0",
  list_projects: "1.0",
  describe_project: "1.0",
  reload_config: "1.0",
  prepare_weixin_login: "1.0",
  reload_extensions: "1.0",
  skill_list: "1.0",
  skill_read: "1.0",
  skill_write: "1.0",
  skill_create: "1.0",
  skill_delete: "1.0",
  skill_import: "1.0",
  skill_validate: "1.0",
  skill_scan: "1.0",
  always_on_apply: "1.0",
  always_on_rerun_plan: "1.0",
  // 1.1
  always_on_list_plans: "1.1",
  always_on_read_report: "1.1",
  always_on_list_cycles: "1.1",
  always_on_archive_cycle: "1.1",
  always_on_apply_cycle: "1.1",
  knowledge_capabilities: "1.1",
  // 1.2
  approval_list_pending: "1.2",
  approval_decide: "1.2",
  // 1.3
  cron_update: "1.3",
  // 1.4
  panel_heartbeat: "1.4",
  team_panel_snapshot: "1.4",
  team_tool_call: "1.4",
  // 1.5
  kanban_get: "1.5",
  kanban_add_card: "1.5",
  kanban_update_card: "1.5",
  kanban_move_card: "1.5",
  kanban_archive_card: "1.5",
  kanban_restore_card: "1.5",
  kanban_purge_card: "1.5",
  kanban_bulk_archive_cards: "1.5",
  kanban_bulk_move_cards: "1.5",
  kanban_duplicate_card: "1.5",
  kanban_move_card_to_project: "1.5",
  kanban_add_column: "1.5",
  kanban_rename_column: "1.5",
  kanban_delete_column: "1.5",
  kanban_reorder_columns: "1.5",
  kanban_undo: "1.5",
  kanban_subscribe: "1.5",
  kanban_unsubscribe: "1.5",
  // 1.6
  steer_turn: "1.6",
  cancel_steer: "1.6",
  // 1.7
  edit_last_turn: "1.7",
  regenerate_last_turn: "1.7",
  // 1.8
  close_project_sessions: "1.8",
} satisfies Record<WsGatewayMethod, GatewayProtocolVersion>;

/**
 * 当前协议版本 = 台账末条（派生而非手写：bump 必须同时加一条 release，
 * 登记新方法必须选一个已声明的版本）。
 */
export const SATI_GATEWAY_PROTOCOL_VERSION: GatewayProtocolVersion =
  PROTOCOL_RELEASES[PROTOCOL_RELEASES.length - 1].version;

/** `protocolLedgerIssues` 的问题分类（机器可读，便于 spec 精确断言）。 */
export type ProtocolLedgerIssueCode =
  | "version-malformed"
  | "version-duplicate"
  | "version-not-ascending"
  | "version-gap"
  | "release-without-credit"
  | "method-version-unknown"
  | "current-not-latest";

export type ProtocolLedgerIssue = {
  code: ProtocolLedgerIssueCode;
  detail: string;
};

/** 校验入参的最小形状（允许 spec 注入畸形台账做负控制）。 */
export type ProtocolLedgerInput = {
  releases: readonly { version: string; changes?: readonly string[] }[];
  methodVersions: Readonly<Record<string, string>>;
  currentVersion: string;
};

function parseProtocolVersion(version: string): { major: number; minor: number } | null {
  const match = /^(\d+)\.(\d+)$/.exec(version);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * 台账自洽性校验（纯函数）：版本连续 + 版本与方法互相 credit + 常量等于末条。
 *
 * 刻意**不**校验「新增方法是否伴随 bump」——那需要发布历史（git tag / 上一个
 * `package.json` 版本）作为第二事实源，当前不可得。残余缺口见台账
 * `TD-GATEWAY-N02`：把新方法登记在**当前**版本上而不 bump，本判据无法判定。
 */
export function protocolLedgerIssues(input: ProtocolLedgerInput): ProtocolLedgerIssue[] {
  const issues: ProtocolLedgerIssue[] = [];
  const declared = new Set<string>();
  const credited = new Set(Object.values(input.methodVersions));
  let prev: { major: number; minor: number } | null = null;
  let prevLabel = "";

  input.releases.forEach((release, index) => {
    const parsed = parseProtocolVersion(release.version);
    if (parsed === null) {
      issues.push({
        code: "version-malformed",
        detail: `PROTOCOL_RELEASES[${index}] 的版本号 ${release.version} 不是 MAJOR.MINOR 形式`,
      });
      return;
    }
    if (declared.has(release.version)) {
      issues.push({ code: "version-duplicate", detail: `版本 ${release.version} 在台账中重复声明` });
    }
    declared.add(release.version);

    if (prev === null) {
      if (parsed.major !== 1 || parsed.minor !== 0) {
        issues.push({
          code: "version-gap",
          detail: `台账首条必须是 1.0 基线，实为 ${release.version}`,
        });
      }
    } else if (parsed.major !== prev.major || parsed.minor <= prev.minor) {
      issues.push({
        code: "version-not-ascending",
        detail: `台账须按版本严格升序：${release.version} 未大于前一条 ${prevLabel}`,
      });
    } else if (parsed.minor !== prev.minor + 1) {
      issues.push({
        code: "version-gap",
        detail: `版本序列出现空洞：${prevLabel} → ${release.version}`,
      });
    }

    if (!credited.has(release.version) && (release.changes ?? []).length === 0) {
      issues.push({
        code: "release-without-credit",
        detail: `版本 ${release.version} 既没有方法登记也没有 changes 说明（MINOR 无内容）`,
      });
    }

    prev = parsed;
    prevLabel = release.version;
  });

  for (const [method, version] of Object.entries(input.methodVersions)) {
    if (!declared.has(version)) {
      issues.push({
        code: "method-version-unknown",
        detail: `方法 ${method} 登记在台账未声明的版本 ${version}`,
      });
    }
  }

  const last = input.releases[input.releases.length - 1];
  if (last === undefined) {
    issues.push({ code: "version-gap", detail: "PROTOCOL_RELEASES 为空" });
  } else if (last.version !== input.currentVersion) {
    issues.push({
      code: "current-not-latest",
      detail: `SATI_GATEWAY_PROTOCOL_VERSION=${input.currentVersion} 与台账末条 ${last.version} 不一致`,
    });
  }

  return issues;
}

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
