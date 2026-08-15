import { join } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { findOpenRequest } from "../transcript/interruptedTurn.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { listProjectSessions } from "../storage/SessionList.js";
import { sanitizeSessionIdForPath } from "../storage/ProjectSessionStorage.js";

/**
 * 跨进程重启续算（计划 docs/cross-process-retry-resume-plan.md T-C）。
 *
 * gateway 启动时枚举会话，识别「request_header 已落、响应未到」的 (a) 形态断点
 * （请求完全未响应），向宿主提交续算 turn：宿主 resume 会话（旧开放 turn 由
 * resumeAgentSession 合成 interrupted 收尾）后以新 turn 继续，任务自动续算到完成。
 *
 * 设计要点：
 *   - 判定只读 transcript（唯一真源），零内存态；
 *   - (b) 形态（流式残片已落）首期不自动续算（append-only 无法删残片）；
 *   - 有挂起审批（输出门禁 HITL）的会话跳过（审批态在 gateway 内存，崩溃即失）；
 *   - submittedKeys 防本次启动内重复提交；跨启动防重靠 transcript 状态（续算 turn
 *     自身也成为 open turn 时由下一次扫描继续推进）。
 */

/** 续算输入标记：UI/审计可据此识别系统发起的续算 turn。 */
export const RESUME_TURN_MARKER = "[system-resume]";

/** 续算输入文本：作为新 turn 的用户消息提交（模型可见）。 */
export const RESUME_TURN_MESSAGE = `${RESUME_TURN_MARKER} 你上一次运行因进程中断而停止。请先检查当前已完成的进度（不要重复执行已经完成的工作），然后继续完成未完成的工作。`;

export type TaskResumeScannerOptions = {
  /** 会话所在项目根（chatDir 按项目隔离）。 */
  projectRoot: string;
  pilotHome: string;
  /** 提交续算 turn；宿主接线到 gateway.submitTurn（构造完整 GatewaySubmitTurnInput）。 */
  submitResumeTurn: (sessionKey: string) => Promise<void>;
  /** 会话是否有挂起审批；缺省视为无。 */
  hasPendingApprovals?: (sessionKey: string) => boolean;
  /** 本次启动已提交的会话（防重复）。 */
  submittedKeys?: Set<string>;
};

export type TaskResumeScanResult = {
  scanned: number;
  /** 已提交续算的会话数。 */
  resumed: number;
  /** (b) 形态（流式残片）跳过数。 */
  skippedPartial: number;
  /** 有挂起审批跳过数。 */
  skippedApprovals: number;
};

export class TaskResumeScanner {
  private readonly options: TaskResumeScannerOptions;

  constructor(options: TaskResumeScannerOptions) {
    this.options = options;
  }

  /**
   * 扫描并提交续算。异步、不抛错（宿主 fire-and-forget 调用）；单个会话的
   * 提交失败仅计数，不影响其余会话。
   */
  async scan(): Promise<TaskResumeScanResult> {
    const sessions = await listProjectSessions({
      projectRoot: this.options.projectRoot,
      pilotHome: this.options.pilotHome,
      includeInternal: false,
    });
    const chatDir = getPilotProjectChatDir(this.options.projectRoot, this.options.pilotHome);
    const result: TaskResumeScanResult = {
      scanned: sessions.length,
      resumed: 0,
      skippedPartial: 0,
      skippedApprovals: 0,
    };
    for (const info of sessions) {
      const sessionKey = info.sessionId;
      if (this.options.submittedKeys?.has(sessionKey)) {
        continue;
      }
      try {
        const path = join(chatDir, `${sanitizeSessionIdForPath(sessionKey)}.jsonl`);
        const { entries } = await readTranscript(path);
        const open = findOpenRequest(entries);
        if (open === undefined) {
          continue;
        }
        if (open.form !== "a") {
          result.skippedPartial += 1;
          continue;
        }
        if (this.options.hasPendingApprovals?.(sessionKey)) {
          result.skippedApprovals += 1;
          continue;
        }
        await this.options.submitResumeTurn(sessionKey);
        this.options.submittedKeys?.add(sessionKey);
        result.resumed += 1;
      } catch {
        // 单会话失败（读盘/提交异常）不阻塞整轮扫描；宿主负责日志。
      }
    }
    return result;
  }
}
