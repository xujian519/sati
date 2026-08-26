/**
 * 看板（Kanban）运行时管理器。
 *
 * - 按项目缓存 `BoardRuntime` 实例。
 * - 维护 `projectId -> 订阅者` 映射，用于 `kanban_updated` 事件风扇分发。
 * - 订阅/取消订阅由 WebSocket 连接层直接调用；业务方法由 `InProcessGateway` 调用。
 */

import { resolve } from "node:path";
import { BoardRuntime } from "../../board/runtime/BoardRuntime.js";
import type { KanbanUpdatedPayload } from "../../board/protocol/types.js";

export type KanbanSubscriber = {
  /** 订阅者标识，用于取消订阅。 */
  id: string;
  /** 发送事件回调；通常由连接层实现为 `sendNotification("kanban_updated", payload)`。 */
  send: (payload: KanbanUpdatedPayload) => void;
};

export class KanbanBoardManager {
  private readonly runtimes = new Map<string, BoardRuntime>();
  private readonly subscribers = new Map<string, Set<KanbanSubscriber>>();

  /**
   * 规范化项目标识：resolve 为绝对路径并归一化（去尾部分隔符/`.`/`..`），
   * 使 UI（传 Project.path 原文）与 agent 工具（传 resolve(cwd)）对同一目录
   * 得到一致的缓存键与广播 projectId，避免产生「两个 runtime / 事件不达」。
   */
  private normalizeProjectKey(key: string): string {
    return resolve(key);
  }

  /**
   * 订阅某项目的 kanban_updated 事件。
   * 同一订阅者对同一项目多次订阅幂等（Set 去重）。
   */
  subscribe(projectId: string, subscriber: KanbanSubscriber): void {
    const id = this.normalizeProjectKey(projectId);
    let set = this.subscribers.get(id);
    if (set === undefined) {
      set = new Set();
      this.subscribers.set(id, set);
    }
    set.add(subscriber);
  }

  /**
   * 取消订阅某项目的 kanban_updated 事件。
   * 取消后若该项目无订阅者，清理对应 Set 条目。
   */
  unsubscribe(projectId: string, subscriber: KanbanSubscriber): void {
    const id = this.normalizeProjectKey(projectId);
    const set = this.subscribers.get(id);
    if (set === undefined) return;
    set.delete(subscriber);
    if (set.size === 0) {
      this.subscribers.delete(id);
    }
  }

  /** 取消该订阅者在所有项目上的订阅（连接关闭时调用）。 */
  unsubscribeAll(subscriber: KanbanSubscriber): void {
    for (const [projectId, set] of this.subscribers) {
      set.delete(subscriber);
      if (set.size === 0) {
        this.subscribers.delete(projectId);
      }
    }
  }

  /** 风扇分发 kanban_updated 事件给所有订阅该项目的订阅者。 */
  broadcast(projectId: string, payload: KanbanUpdatedPayload): void {
    const id = this.normalizeProjectKey(projectId);
    const set = this.subscribers.get(id);
    if (set === undefined) return;
    for (const subscriber of set) {
      try {
        subscriber.send(payload);
      } catch {
        // 发送失败时忽略，避免单个订阅者拖垮广播。
      }
    }
  }

  /**
   * 获取/创建某项目的 BoardRuntime。
   * `projectRoot` 用于文件落盘；`projectId` 用于事件订阅与 payload。
   * 两者均规范化后再作为缓存键，保证同一项目只有一份 runtime。
   */
  getRuntime(projectRoot: string, projectId: string): BoardRuntime {
    const nRoot = this.normalizeProjectKey(projectRoot);
    const nId = this.normalizeProjectKey(projectId);
    const key = `${nRoot}\0${nId}`;
    let runtime = this.runtimes.get(key);
    if (runtime === undefined) {
      runtime = new BoardRuntime({
        projectId: nId,
        projectRoot: nRoot,
        emit: (pid, payload) => this.broadcast(pid, payload),
      });
      this.runtimes.set(key, runtime);
    }
    return runtime;
  }

  /** 清除缓存的运行时（测试/热重载场景）。 */
  clearRuntimes(): void {
    this.runtimes.clear();
  }
}
