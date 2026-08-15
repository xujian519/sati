/**
 * 文件观测三态语义与写意图分类（阶段四 T5）。
 *
 * 模型对工作区文件的写操作前置「必须先读」：注册表按路径记录观测状态——
 * present（读过，快照含 mtime/内容哈希）/ absent（观测到不存在）/ unseen
 * （未观测）。写意图分类纯函数给出确定性裁决：create（文件不存在）／
 * overwrite（存在且版本新鲜）／refuse（未观测 file_not_observed，或版本
 * 过期 file_stale_version）。与 dsh fs-observation-policy 的
 * FS_NOT_OBSERVED / FS_STALE_VERSION 语义对应。
 *
 * resume 语义：观测状态是会话内存态，resume 后为空（unseen），文件需重读
 * 后方可写——与既有 readFileState/writeSnapshots 行为一致。
 */
import type { SatiWriteSnapshotEntry } from "../../protocol/types.js";

/** 文件观测三态。 */
export type ObservedFileState = "present" | "absent" | "unseen";

export type WriteIntentDecision =
  | { intent: "create" }
  | { intent: "overwrite" }
  | {
      intent: "refuse";
      /** 稳定错误码：未观测 / 版本过期。 */
      code: "file_not_observed" | "file_stale_version";
      message: string;
    };

/**
 * 依据观测快照与当前文件事实分类一次写意图。
 *
 * @param input - 路径、观测快照（可能缺省）、当前文件存在性、mtime/内容哈希是否匹配。
 * @returns 确定性裁决。
 */
export function classifyWriteIntent(input: {
  path: string;
  snapshot: SatiWriteSnapshotEntry | undefined;
  exists: boolean;
  mtimeMatches: boolean;
  hashMatches: boolean;
  fullRead: boolean;
}): WriteIntentDecision {
  if (!input.exists) {
    // create-if-absent：文件当前不存在即可创建（无论此前是否观测过）。
    return { intent: "create" };
  }
  if (input.snapshot === undefined) {
    return {
      intent: "refuse",
      code: "file_not_observed",
      message: "File has not been read yet. Read it first before writing to it.",
    };
  }
  if (input.mtimeMatches || (input.fullRead && input.hashMatches)) {
    return { intent: "overwrite" };
  }
  return {
    intent: "refuse",
    code: "file_stale_version",
    message: "File has changed since the last read. Read it again before writing to it.",
  };
}

/**
 * 观测状态视图：有快照且文件存在为 present；快照缺失为 unseen；
 * 快照存在但记录的是「观测到不存在」为 absent（当前实现用快照存在与否表示，
 * 保留该函数作为三态模型的显式文档化视图）。
 *
 * @param snapshot - 观测快照（可能缺省）。
 * @returns 三态之一。
 */
export function observedStateOf(snapshot: SatiWriteSnapshotEntry | undefined): ObservedFileState {
  return snapshot === undefined ? "unseen" : "present";
}
