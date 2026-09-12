/**
 * 团队子系统（M1/M2）装配（P4a 第四刀）：从 createLocalGateway.ts 工厂搬出。
 *
 * 覆盖 durable 成员底座（teams.db）、队长审批转发、冷恢复扫描（成员断点续算）、
 * 事件驱动调度器与启动扫描编排；捕获绑定改写为 `deps.` 字段，其余文本逐字保留。
 *
 * 启动扫描顺序由调用方保证：`buildTeamSubsystem()` → 注入 team 工具到 registry →
 * `startStartupScan()`。工厂原先就是这个顺序（工具未注入就唤醒成员会让会话看不到
 * team_* 工具），故扫描不从 builder 内部自启。
 */

import { join as joinPath } from "node:path";
import {
  type ScanStrandedTasksResult,
  type ScanTeamMembersResult,
  TeamApprovalForwarder,
  TeamDb,
  type TeamEvent,
  TeamScheduler,
  TeamShare,
  defaultTeamDbPath,
  invalidateTaskAttempt,
  scanStrandedTasks,
  scanTeamMembers,
  toGatewayEvent,
  wakeMember,
  withTeamLock,
} from "../agent/team/index.js";
import { InProcessGateway } from "../gateway/index.js";
import { SessionPresence } from "../gateway/server/sessionPresence.js";
import { WorkerRegistry, defaultPatentWorkers } from "../patent/index.js";
import { logger } from "../telemetry/index.js";
import { handleMemberTurnCompleted } from "./gatewaySupport.js";

export type TeamSubsystemDeps = {
  pilotHome: string;
  env: Record<string, string | undefined>;
  gateway: InProcessGateway;
  fallbackProjectRoot: string;
  sessionPresence: SessionPresence;
  mailboxLeaseMs: number | undefined;
};

export type TeamSubsystemRuntime = {
  db: TeamDb;
  scheduler: TeamScheduler;
  emitTeamEvent: (captainSessionKey: string, event: TeamEvent) => boolean;
  workerRegistry: WorkerRegistry;
  runMemberScan: () => Promise<ScanTeamMembersResult>;
  runStrandedScan: () => Promise<ScanStrandedTasksResult>;
  /** 成员冷恢复 + stranded 回收的启动扫描；必须在 team 工具注入 registry 之后调用。 */
  startStartupScan: () => Promise<void>;
};

export function buildTeamSubsystem(deps: TeamSubsystemDeps): TeamSubsystemRuntime {
  const teamDb = new TeamDb(defaultTeamDbPath(deps.pilotHome, deps.env));
  // TeamEvent 广播收口（质量审阅 I2）：三处 emit 语义同构（scheduler / 工具集 / 本地函数），
  // 收敛为单一闭包——handleMemberTurnCompleted 补发 task_failed 事件（C2 判失败不再静默）。
  const emitTeamEvent = (captainSessionKey: string, event: TeamEvent): boolean => {
    return deps.gateway.emitForSession(captainSessionKey, toGatewayEvent(event));
  };
  // sessionPresence 声明已上移至 gateway 创建前（panelHeartbeat delegate 闭包引用，
  // 见上方 M3 注释）；此处仅沿用实例。
  // gateway 注入接线（emitForSession/approvalDecide 类型兼容性编译期验证）。
  // handleMemberEvent 由 M2 调度器 wake 包装层 + 冷恢复扫描（下方 runMemberScan 的 onEvent）
  // 双路径消费——调度器路径与 scanner 路径的 approval_pending 均冒泡到队长 watcher。
  const teamForwarder = new TeamApprovalForwarder({
    db: teamDb,
    emitForSession: (sessionKey, event) => deps.gateway.emitForSession(sessionKey, event),
    approvalDecide: input => deps.gateway.approvalDecide(input),
  });
  const runMemberScan = (): Promise<ScanTeamMembersResult> => {
    // 冷恢复回合结束（turn_completed）的成员收口集合（每成员至多一次）。
    const completed: Array<{ teamId: string; memberId: string }> = [];
    const reclaimCompleted = (): void => {
      // 恢复回合已完全收尾（wakeMember 仅在 submitTurn 生成器完全 unwinding——
      // 消费者 finally 内 router.endTurn 已执行、会话槽已释放——之后才返回），
      // 此刻续派与 warm 路径锁内串行等效，不会命中 session_busy。
      for (const { teamId, memberId } of completed) {
        handleMemberTurnCompleted(teamDb, teamScheduler, teamId, memberId, emitTeamEvent);
      }
    };
    return scanTeamMembers({
      db: teamDb,
      gateway: deps.gateway,
      projectRoot: deps.fallbackProjectRoot,
      pilotHome: deps.pilotHome,
      // P0-3：挂起审批判定 = 内存 bus 或持久化表（bus 为内存态崩溃即失，冷恢复后该成员
      // 依据持久化表被判"挂起"并冒泡/跳过）。
      hasPendingApprovals: sessionKey =>
        deps.gateway.getApprovalBus().list(sessionKey).length > 0 || teamDb.hasPendingApproval(sessionKey),
      // P0-3：挂起审批成员冒泡 member_stalled_approval 给队长（emitTeamEvent 闭包 597 行）。
      emitTeamEvent,
      // I1（code review）：冷恢复 turn 的 approval_pending 冒泡到队长 watcher——
      // scanner 直调 wakeMember 现传 onEvent（M1 已知限制在此闭环，计划 1349 行承诺兑现）。
      onEvent: (member, event) => {
        teamForwarder.handleMemberEvent(member, event);
        // M3（复审观察项 3）：冷恢复回合结束 → 与 wake 包装层同款收口（C2 + onMemberIdle 续派）。
        // 只在事件回调内登记、不立即续派：冷恢复路径无团队锁（scanTeamMembers 直调
        // wakeMember，不经 scheduler 的 withTeamLock），回合结束事件在 submitTurn
        // 生成器迭代内同步送达——立即续派会在生成器 unwinding（消费者 finally 内
        // router.endTurn）之前发起下一次 wake，beginTurn 判 busy（session_busy
        // 事件流空转、wake 包装层照常返回 true）→ 任务卡 claimed 永不续派；
        // 延后宏任务同样不可靠（pump 收尾可跨宏任务）。warm 路径同款延后
        //（wake 包装层收集 completed、wake 返回后收口，见下方 teamScheduler 接线）。
        if (event.type === "turn_completed" && member.teamId !== undefined) {
          completed.push({ teamId: member.teamId, memberId: member.id });
        }
      },
    })
      .then(result => {
        if (result.resumed > 0) {
          logger.info(`Team member resume: scanned=${result.scanned}, resumed=${result.resumed}`);
        }
        reclaimCompleted();
        return result;
      })
      .catch(() => {
        reclaimCompleted();
        return { scanned: 0, resumed: 0 };
      });
  };
  // ── 团队调度器接线（M2）：事件驱动调度器 + M1 已知限制闭环 ──
  // wake 包装层：调 wakeMember 并在 onEvent 内捕获 turn_completed → onMemberIdle，
  // 成员回合结束自动触发下一任务派发 + member_idle 广播（M1 冷恢复 turn 审批冒泡
  // 限制已由 runMemberScan 的 onEvent 接线闭环——下方 I1 注释）。
  // onMemberIdle 的异步 rejection 静默吞掉（onEvent 契约：回调不得抛出，也不得以
  // 异步 rejection 影响回合；dispose 后锁队列里残留的踢腿自然失败被吞）。
  // M3 锁范围收窄（原"wake 全程持有团队锁"已废弃）：认领在调度器锁内完成，成员
  // 回合全程不持团队锁——回合内 team_update_task 等团队工具取同一把锁，持锁唤醒
  // 会重入死锁（M3 集成测试暴露）；回合结束收口（C2 + onMemberIdle 续派）延后至
  // wake 返回后，与 scanner 冷恢复路径同款（下方 onEvent 内 completed 收集）。
  // I3（code review）闭环：captain 离线（连接断开超宽限窗）→ 暂停新认领；
  // unknown（纯 in-process/CLI 场景）容错视为在线，不阻塞成员工作。
  // ⚠️ 最终复审 I1（已知边界）：Web 主路径经 ui/server relay 单条共享 ws 连接（sati-bridge 单例），
  // 浏览器关闭不触发 gateway onClose → Web 用户下线判定不生效（fail-open 回到 M2 行为：成员成果
  // 持久化不丢失、C2 有界重试）；CLI/TUI 直连 ws 路径正常。M4 面板接线时以浏览器连接级信号为准。
  // 阶段 3：专利 worker 注册表——team_create_task 的 workerName 存在性校验 + 调度器分派
  // 时的角色 tier 校验共用同一实例（缺省仅内置 6 个 worker，provision-* 条款 worker 未注册
  // 时不阻塞：workerName 校验与分派校验均 fail-open）。
  const workerRegistry = new WorkerRegistry();
  for (const worker of defaultPatentWorkers()) {
    workerRegistry.register(worker);
  }
  const teamScheduler = new TeamScheduler({
    db: teamDb,
    emit: emitTeamEvent,
    isCaptainOnline: captainSessionKey => deps.sessionPresence.isActive(captainSessionKey),
    workerRegistry,
    // P1-5：邮箱投递租约宽限参数化（默认 60s，调度器邮箱未读判定/租约过期复用）。
    mailboxLeaseMs: deps.mailboxLeaseMs,
    // P1-4：成员任务唤醒 turn 0 注入共享黑板摘要（订阅方读 {projectRoot}/.sati/team-workspace/{teamId}/share.jsonl；
    // 空黑板返回 undefined 不注入注记——与 assignmentPrompt 的 sharedContext 空串跳过一致）。
    readSharedBoardSummary: teamId => {
      try {
        const summary = new TeamShare(
          joinPath(deps.fallbackProjectRoot, ".sati", "team-workspace", teamId, "share.jsonl"),
        ).summary();
        return summary.length > 0 ? summary : undefined;
      } catch {
        // 黑板不存在/读失败：容错视作无共享上下文，不阻塞成员唤醒。
        return undefined;
      }
    },
    wake: async (memberId, message) => {
      try {
        // 成员快照一次读取（onEvent 内每事件复用；handleMemberEvent 需要 teamId/sessionKey）。
        // 读在 try 内：wake 永不抛错（db 已关等竞态统一走 catch → false 回滚路径）
        const member = teamDb.getMember(memberId);
        // 回合结束收口延后到 wake 返回后（M3 锁范围收窄：kickMember 已锁外唤醒，团队锁
        // 不再跨回合持有——turn_completed 在 submitTurn 生成器迭代内同步送达，若在事件
        // 回调内立即续派会先于消费者 finally 的 endTurn 命中 session_busy；wake 返回时
        // 生成器已完全 unwinding、endTurn 已执行、会话槽已释放，与 scanner 冷恢复路径同款）。
        const completed: Array<{ teamId: string; memberId: string }> = [];
        const reclaimCompleted = (): void => {
          for (const { teamId, memberId: m } of completed) {
            handleMemberTurnCompleted(teamDb, teamScheduler, teamId, m, emitTeamEvent);
          }
        };
        let ok = false;
        try {
          await wakeMember(teamDb, deps.gateway, memberId, message, {
            onEvent: event => {
              // 审批冒泡（M1 Task 6 接线点）：成员回合的 approval_pending → 队长会话 watcher
              if (member !== undefined) {
                teamForwarder.handleMemberEvent(member, event);
              }
              // M1 已知限制闭环 + M3（复审观察项 3）：回合结束 → C2 检查 + onMemberIdle
              //（下一任务派发 + member_idle 广播）；与 scanner 冷恢复路径共用共享函数收口。
              if (event.type === "turn_completed" && member?.teamId !== undefined) {
                completed.push({ teamId: member.teamId, memberId });
              }
            },
          });
          ok = true;
        } finally {
          // M1（T12 复审）：仅正常路径收口——抛错路径交给外层 kickMember 回滚统一处理
          //（回滚里成员回 idle；此处再续派 onMemberIdle 会踩掉并发重认领写下的 working 状态）
          if (ok) reclaimCompleted();
        }
        return true;
      } catch {
        // 唤醒成员回合失败 → 返回 false 交由调用方决定重试，不在此吞掉。
        return false;
      }
    },
  });
  // M2：stranded 任务冷恢复——invalidate 旧 attempt（生成 handoffId 拒绝迟到写）
  // 后交调度器 kickMember：锁内重读成员状态 + ownedOpenTask 优先 → 自动 re-claim。
  const runStrandedScan = (): Promise<ScanStrandedTasksResult> =>
    scanStrandedTasks({
      db: teamDb,
      invalidateAndKick: async (teamId, taskId, memberId) => {
        // C1（code review）：invalidate 进团队锁 + 锁内复查——stranded 判定基于扫描
        // 起点快照，与调度器锁内 claim 存在 TOCTOU（启动扫描 fire-and-forget 与就绪后
        // 调度并发）；成员 working（活跃回合）或任务已被并发转派的不得 invalidate
        // （防同一任务双执行）。kickMember 留在锁外（kickMember 内部自己拿锁，避免重入死锁）。
        await withTeamLock(teamId, async () => {
          const task = teamDb.getTask(teamId, taskId);
          const member = teamDb.getMember(memberId);
          if (task === undefined || member === undefined) return;
          if (task.status !== "claimed" && task.status !== "in_progress") return;
          if (member.status === "working" || teamDb.isRetired(member.sessionKey)) return;
          teamDb.updateTask(invalidateTaskAttempt(task, {}));
        });
        await teamScheduler.kickMember(teamId, memberId);
      },
    });

  const startStartupScan = (): Promise<void> =>
    (async () => {
      teamDb.resetMemberStatuses();
      // P0-3：从 teams.db 挂起审批表重建内存审批总线——bus 为进程内存态，崩溃即失；
      // 冷启动恢复后成员挂起审批仍对队长可见（approval_list_pending/UI 卡片），
      // 且 decide 有 pendingIndex 依据（会话未被重建时 delivered:false → 收敛删除）。
      for (const row of teamDb.listPendingApprovals()) {
        deps.gateway.getApprovalBus().register({
          sessionKey: row.sessionKey,
          pendingIndex: row.pendingIndex,
          textPreview: row.textPreview,
          triggerKeyword: row.triggerKeyword,
          sessionId: row.sessionId,
          turnId: row.turnId,
          createdAt: Date.parse(row.createdAt),
        });
      }
      await runMemberScan();
      await runStrandedScan();
    })().catch(error => logger.error("Team startup scan failed:", error));
  return {
    db: teamDb,
    scheduler: teamScheduler,
    emitTeamEvent,
    workerRegistry,
    runMemberScan,
    runStrandedScan,
    startStartupScan,
  };
}
