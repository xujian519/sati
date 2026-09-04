/**
 * Mid-turn steering 邮箱（协议 1.6 `steer_turn` 的引擎侧底座）。
 *
 * turn 进行中允许用户投递"插话"：投递项在下一次模型调用边界被 AgentLoop
 * 取走并注入消息序列尾部（不破坏 prompt-cache 前缀）。mailbox 生命周期与
 * turn 对齐——start() 开启、drainOrClose() 收尾同步关闭（关闭后 enqueue
 * 返回 undefined，杜绝"turn 已结束但消息被吞"的静默丢失）；cancel 记墓碑，
 * 防止已撤回项经后续 drain 复活。
 */
import { randomUUID } from "node:crypto";

/** 一条排队的插话项。 */
export type SteerItem = {
  steerId: string;
  text: string;
  enqueuedAt: number;
};

/** AgentLoop 消费的窄接口：只暴露 drain，避免 loop 依赖完整邮箱实现。 */
export type SteerSource = {
  drain(): SteerItem[];
};

const MAX_QUEUED_STEER_ITEMS = 16;

/**
 * 单 turn 插话邮箱。
 *
 * 并发语义：enqueue/cancel/drain/drainOrClose 均为同步方法（Node 单线程
 * 事件循环内无抢占），无需锁；唯一要求是 drainOrClose 与 enqueue 的先后
 * 顺序由调用方事件循环天然串行化。
 */
export class SteerMailbox implements SteerSource {
  private open = false;
  private currentTurnId: string | undefined;
  private queue: SteerItem[] = [];
  /** 已撤回项的墓碑：drain 永远跳过，防复活。 */
  private readonly tombstones = new Set<string>();

  /** turn 开始：清空上一 turn 残留并开启接收。 */
  start(turnId: string): void {
    this.open = true;
    this.currentTurnId = turnId;
    this.queue = [];
    this.tombstones.clear();
  }

  /**
   * 投递一条插话。仅在 mailbox 开启（turn 进行中）且未超队列上限时成功；
   * 返回入列项，失败返回 undefined（调用方据此返回 `no_active_turn` /
   * `busy` 给客户端）。
   */
  enqueue(text: string): SteerItem | undefined {
    if (!this.open || this.queue.length >= MAX_QUEUED_STEER_ITEMS) return undefined;
    const item: SteerItem = { steerId: randomUUID(), text, enqueuedAt: Date.now() };
    this.queue.push(item);
    return item;
  }

  /** 撤回一条尚未消费的插话（排队未注入即成功；已消费/未知 id 失败）。 */
  cancel(steerId: string): boolean {
    const index = this.queue.findIndex(item => item.steerId === steerId);
    if (index === -1) return false;
    this.queue.splice(index, 1);
    this.tombstones.add(steerId);
    return true;
  }

  /**
   * 模型调用边界取走全部待消费项（过滤墓碑残留）。取走即消费：同一项
   * 不会出现在两次 drain 的结果里。
   */
  drain(): SteerItem[] {
    if (!this.open || this.queue.length === 0) return [];
    const items = this.queue;
    this.queue = [];
    return items;
  }

  /**
   * turn 收尾：取走剩余项并同步关闭。关闭后 enqueue 一律失败——调用方
   * （gateway）把失败显式回给客户端，而不是让消息消失在已结束的 turn 里。
   */
  drainOrClose(): SteerItem[] {
    const items = this.queue;
    this.queue = [];
    this.open = false;
    this.currentTurnId = undefined;
    return items;
  }

  /** 当前排队项快照（active_turn_snapshot 展示用，不消费）。 */
  pending(): SteerItem[] {
    return this.queue.map(item => ({ ...item }));
  }

  isOpen(): boolean {
    return this.open;
  }

  turnId(): string | undefined {
    return this.currentTurnId;
  }
}
