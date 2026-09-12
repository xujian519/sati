/**
 * 专利输出门禁构造（P4a 第六刀，类内拆分）：从 ProjectRuntimeRegistry.prepareSessionRuntime 搬出。
 *
 * 每会话一个 PatentOutputGate：命中审批词/规则的消息挂起等人工审批，审批经 gateway
 * `approval_list_pending` / `approval_decide` 暴露给 Web/TUI；成员会话的挂起项同步落
 * teams.db（P0-3，崩后冷恢复重建）。另含两条默认关闭的通道：决策溯源旁路（P6）与
 * 宪法规则工具拦截（policy-bridge，编译出的 deny 规则由调用方登记）。
 *
 * 四处 accessor 延迟取数是有意的，与原闭包语义一致：gateway 与 teams.db 由 setter 晚绑定、
 * 会话覆盖可被 updateSubsystems 整体替换、projectRoot 来自本次调用的 runtime。
 */

import { join as joinPath } from "node:path";
import { ENV_KEY, brandEnv } from "../env.js";
import type { SessionConfigOverrides } from "../always-on/runtime/SessionConfigOverrides.js";
import { TeamDb, parseMemberSessionKey } from "../agent/team/index.js";
import { InProcessGateway } from "../gateway/index.js";
import {
  CASE_ROOT_REL,
  PatentOutputGate,
  type PendingPatentMessage,
  appendInventivenessFeedback,
  caseInventivenessFeedbackPath,
  extractMessageText,
  findCaseIdBySession,
} from "../patent/index.js";
import { isProvenanceEnabled } from "../patent/provenance/index.js";
import { RuleOutputGate, loadPatentFullRuleSet, rulesToPolicyDenyRules, selectGateRules } from "../rule/index.js";
import { type PermissionRule } from "../permission/index.js";
import { createLogger } from "../telemetry/index.js";
import { createApprovalStoreSafely } from "./gatewaySupport.js";

export type PatentOutputGateDeps = {
  sessionKey: string;
  projectRoot: string;
  env: Record<string, string | undefined>;
  enableProvenance: boolean | undefined;
  now: () => Date;
  /** 审批总线与广播宿主；未接线时为 undefined（原语义：闭包内延迟读取）。 */
  getGateway: () => InProcessGateway | undefined;
  /** 成员会话挂起审批持久化；无团队时为 undefined。 */
  getTeamDb: () => TeamDb | undefined;
  /** 会话级 cwd 覆盖（决策反馈回流反查 cases 根）；可被 updateSubsystems 替换。 */
  getSessionOverrides: () => SessionConfigOverrides | undefined;
};

export type PatentOutputGateBuild = {
  gate: PatentOutputGate;
  /** policy-bridge 编译出的 deny 规则；由调用方登记到 per-project 表。 */
  policyDenyRules: PermissionRule[];
};

const patentOutputGateLogger = createLogger("PatentOutputGate");
const ruleOutputGateLogger = createLogger("RuleOutputGate");

export function buildPatentOutputGate(deps: PatentOutputGateDeps): PatentOutputGateBuild {
  /**
   * 专利输出门禁（每会话一个）：命中审批词的消息挂起等待人工审批，审批入口
   * 为 `AgentSession.approvePendingOutput/rejectPendingOutput`，经 gateway
   * `approval_list_pending` / `approval_decide` 命令暴露给审批 UI（Web/TUI）。
   * 挂起时把条目注册进 gateway 审批总线并广播 `approval_pending` 事件；
   * 审批完成（onApproved/onRejected）时从总线移除并广播 `approval_resolved`。
   * 消息本体挂起时已入库（不丢消息），挂起/审批仅为流程控制。
   *
   * 保守默认：仅保留审批词 HITL 拦截（专利结论/侵权判断/有效性结论/最终建议），
   * 关闭绝对化表述改写、风险词免责声明与法条核验——避免专利词表污染普通会话的
   * 用户可见消息（如"一定/百分百"被追加改写提示）。需要完整门禁时显式传入
   * 关键词表与 `enableCitationGate: true`。
   */
  const sessionKey = deps.sessionKey;
  // 审批完成收口：从总线移除 + 广播 approval_resolved（onApproved/onRejected 共用）。
  // P0-3：同步删除持久化挂起项（成员会话）——bus/表双态收敛，冷恢复 hasPendingApproval
  // 据此不再判定该成员挂起。
  const resolveApproval = (pending: PendingPatentMessage, verdict: "adopted" | "rejected") => {
    deps.getGateway()?.getApprovalBus().remove(sessionKey, pending.index);
    deps.getTeamDb()?.deletePendingApproval(sessionKey, pending.index);
    deps.getGateway()?.emitForSession(sessionKey, {
      type: "approval_resolved",
      sessionKey,
      pendingIndex: pending.index,
      verdict,
    });
  };
  // 规则驱动门禁（B 链）：只接入「出现即违规」的 keyword_blocklist 规则子集
  // （structural_analysis 缺失即违规对任意输出海量误报，仅 rule_check 自检用）。
  // 加载失败（含规则资产缺失/损坏）→ 空规则集降级放行 + 告警。
  const fullRuleSet = loadPatentFullRuleSet();
  if (fullRuleSet.warnings.length > 0) {
    ruleOutputGateLogger.warn(`专利规则集加载告警: ${fullRuleSet.warnings.join("; ")}`);
  }
  const ruleGate = new RuleOutputGate(selectGateRules(fullRuleSet.ruleSet));
  // 宪法规则工具拦截通道（C 链，默认关）：block + keyword_blocklist 且**非输出面 phase**
  // 的规则编译为 policy deny 规则，交 createAgentConfig 前置注入 PermissionContext.rules.deny。
  // phase 语义门见 src/rule/runtime/policy-bridge.ts；当前规则资产的 block 规则均为
  // post_execution（输出面），故开启后编译结果为空——显式告警而非静默"已启用却无规则"。
  const policyDenyRules: PermissionRule[] = [];
  if (brandEnv(deps.env, ENV_KEY.RULE_POLICY_BRIDGE_ENABLED) === "1") {
    const compiled = rulesToPolicyDenyRules(fullRuleSet.ruleSet);
    policyDenyRules.push(...compiled.rules);
    if (compiled.rules.length === 0) {
      ruleOutputGateLogger.warn(
        `policy-bridge 已启用，但当前规则资产无可拦截规则（跳过 ${compiled.skipped.length} 条：block 规则均为输出面语义）`,
      );
    } else {
      ruleOutputGateLogger.info(
        `policy-bridge 已启用：编译 ${compiled.rules.length} 条 deny 规则（跳过 ${compiled.skipped.length} 条）`,
      );
    }
  }

  // 决策溯源旁路（P6 双通道单点）：默认关 → approvalStore 不配置，output-gate 零开销。
  const enableProvenance = isProvenanceEnabled({
    enableProvenance: deps.enableProvenance,
    env: deps.env,
  });
  // 评审 I2：gateway 程序化开启时同步进程级 env，使同一进程内工具层
  // （openProvenanceCollector 读 process.env）与 gateway 判定同源，避免半开状态。
  if (enableProvenance && process.env.SATI_PROVENANCE !== "1") {
    process.env.SATI_PROVENANCE = "1";
  }
  // 评审 I3：审批审计库打开失败（目录只读/损坏/魔数不符）只降级为不落盘，
  // 绝不拖垮 gateway（构造期 fail-open；saveRecord 已内建 fail-open）。
  const approvalStore = enableProvenance ? createApprovalStoreSafely() : undefined;
  const patentOutputGate = new PatentOutputGate({
    riskKeywords: [],
    absolutePhrases: [],
    enableCitationGate: false,
    ruleGate,
    // 审批审计落盘（全局库；写入失败不阻断审批）
    ...(approvalStore !== undefined ? { approvalStore } : {}),
    // 时钟与 Agent 层注入对齐（TurnRunner/AgentLoop 共用 this.options.now）
    now: () => deps.now().getTime(),
    onPending: pending => {
      // 注册进 gateway 审批总线 + 广播 approval_pending（审批 UI 展示入口）。
      const gw = deps.getGateway();
      const textPreview = extractMessageText(pending.processed).trim().slice(0, 500);
      // 关键词审批词优先；否则回退到规则门禁命中的规则 id（含法律依据语义）
      const triggerKeyword = pending.info.approvalKeywordsHit[0] ?? pending.ruleViolations?.[0]?.ruleId ?? "approval";
      if (gw) {
        gw.getApprovalBus().register({
          sessionKey,
          pendingIndex: pending.index,
          textPreview,
          triggerKeyword,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          createdAt: pending.createdAt,
        });
        gw.emitForSession(sessionKey, {
          type: "approval_pending",
          sessionKey,
          pendingIndex: pending.index,
          textPreview,
          triggerKeyword,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          createdAt: pending.createdAt,
        });
      }
      // P0-3：成员会话挂起审批落 teams.db——审批总线是进程内存态，崩溃即失；
      // 落表后冷恢复重建 bus、hasPendingApprovals 判定、decide 收敛有据可依。
      // createdAt 落 ISO 字符串（与 teams/members/tasks 列一致），重建 bus 时转回时间戳。
      const teamDb = deps.getTeamDb();
      const memberKey = parseMemberSessionKey(sessionKey);
      if (memberKey !== null && teamDb) {
        teamDb.upsertPendingApproval({
          teamId: memberKey.teamId,
          memberId: memberKey.memberId,
          sessionKey,
          pendingIndex: pending.index,
          triggerKeyword,
          textPreview,
          sessionId: pending.sessionId,
          turnId: pending.turnId,
          createdAt: new Date(pending.createdAt).toISOString(),
        });
      }
      // 日志仅记录定位信息，不打消息内容（专利结论可能含敏感信息）
      patentOutputGateLogger.warn(
        `专利结论待人工审批: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
      );
    },
    onApproved: pending => {
      resolveApproval(pending, "adopted");
      patentOutputGateLogger.info(
        `审批通过: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
      );
    },
    onRejected: pending => {
      resolveApproval(pending, "rejected");
      patentOutputGateLogger.warn(
        `审批拒绝: session=${pending.sessionId ?? "-"} turn=${pending.turnId ?? "-"} index=${pending.index}`,
      );
    },
    // 决策反馈回流（P2-4 写侧）：modified/rejected 时经 session→case 绑定（
    // patent_workflow_run graph=inventiveness 运行时落盘）反查 caseId，追加进
    // <caseDir>/inventiveness-feedback.jsonl——重跑同 case 时注入 conclude 提示。
    // 绑定缺失/写入失败 fail-open（告警即止），不阻断审批闭环。
    onDecisionFeedback: record => {
      const sessionId = record.sessionId;
      if (sessionId === undefined) return;
      void (async () => {
        // 反查根与工具写侧同源：会话级 cwd 覆盖时工具把绑定写到覆盖目录下，
        // 这里必须走同一解析链（override.cwd ?? projectRoot），否则绑定永远找不到。
        const casesRoot = joinPath(deps.getSessionOverrides()?.get(sessionKey)?.cwd ?? deps.projectRoot, CASE_ROOT_REL);
        const caseId = await findCaseIdBySession(casesRoot, sessionId);
        if (caseId === undefined) return;
        await appendInventivenessFeedback(joinPath(casesRoot, caseInventivenessFeedbackPath(caseId)), {
          caseId,
          originalOutputPreview: record.originalOutputPreview,
          verdict: record.verdict === "modified" ? "modified" : "rejected",
          ...(record.feedback !== undefined ? { feedback: record.feedback } : {}),
          ...(record.modifiedOutput !== undefined ? { modifiedOutput: record.modifiedOutput } : {}),
          // 溯源：绑定按 session 近似归属，同 session 内非创造性链路的审批也会
          // 命中绑定，triggerKeyword 供事后甄别/过滤。
          ...(record.triggerKeyword !== undefined ? { trigger: record.triggerKeyword } : {}),
          decidedAt: record.decidedAt,
        });
        patentOutputGateLogger.info(`创造性人工反馈已回流: case=${caseId} verdict=${record.verdict}`);
      })().catch(err => {
        patentOutputGateLogger.warn(`创造性人工反馈回流失败（fail-open）: ${(err as Error).message}`);
      });
    },
  });
  return { gate: patentOutputGate, policyDenyRules };
}
