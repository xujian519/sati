/**
 * 团队共享黑板原语（P1-4）：成员间"键值上下文"共享。
 *
 * 定位：补"成员间只靠邮箱串联"短板——邮箱是一次性投递消息（投递即阅、驱动 wake），
 * 黑板是可被反复读取的持久化键值上下文（成员 turn 0 读、midway 写、后续成员读）。
 * 与专利侧 TeamLedger（证据声明 / detectTeamConflicts）不同构：后者是专利特有领域
 * 语义；本原语是通用"键值 + 去重 + 落盘 + 重建"最小件，无领域知识。
 *
 * 与邮箱/任务池差异：黑板不驱动调度（写黑板不 kick 成员），只供成员主动读写——调度
 * 仍由任务池 DAG 驱动；黑板是"共享草稿/上下文"，非控制面。
 *
 * 文件格式：JSONL 一行动一个条目（追加写；resume/重放按 toolCallId 去重不重复落）。
 * 目录 {cwd}/.sati/team-workspace/{teamId}/share.jsonl。落盘失败仅内存可见（warn），
 * 审计侧以文件为准（与 TeamLedger appendLine 降级语义一致）。
 *
 * 消费风格：想要某键最新版用 read(key)；想要全史用 list()；成员 turn 0 开局注入用
 * summary()（键 + 各最新值前缀 + 写入者，防 prompt 膨胀）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createLogger } from "../../../telemetry/index.js";

const logger = createLogger("sati");

export type TeamShareEntry = {
  /** 键（如 "结论:t3-新颖性" / "检索范围"）。 */
  key: string;
  /** 值（成员产出的共享上下文，text 摘要或结构化 JSON 字符串）。 */
  value: string;
  /** 写入者（memberId 或 "captain"）。 */
  writer: string;
  /** 写入时间（ISO）。 */
  ts: string;
  /** 来源 turn（可选，溯源）。 */
  turnId?: string;
  /** 来源工具调用 id（可选，resume/重放去重键）。 */
  toolCallId?: string;
};

/** 去重键：同 key + 同 writer + 同 toolCallId 视为同一写入（重放/重试不重复落）。 */
function shareDedupKey(entry: Pick<TeamShareEntry, "key" | "writer" | "toolCallId">): string {
  return `${entry.key}:${entry.writer}:${entry.toolCallId ?? ""}`;
}

export class TeamShare {
  private readonly filePath: string;
  private readonly entries: TeamShareEntry[] = [];
  private readonly seenDedup = new Set<string>();

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  /** 写一条黑板条目（按去重键幂等；追加 JSONL；落盘失败仅内存可见）。 */
  write(entry: TeamShareEntry): void {
    const dedup = shareDedupKey(entry);
    if (this.seenDedup.has(dedup)) return;
    this.seenDedup.add(dedup);
    this.entries.push(entry);
    this.appendLine(JSON.stringify(entry));
  }

  /** 读某 key 的最新条目（无则 undefined）。 */
  read(key: string): TeamShareEntry | undefined {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i];
      if (entry.key === key) return entry;
    }
    return undefined;
  }

  /** 全部条目（按写入序，含同 key 历史版本）。 */
  list(): TeamShareEntry[] {
    return [...this.entries];
  }

  /** 每 key 最新值，按最新写入序倒排（与 read(key) 同义；供读取方截 limit）。 */
  latestValues(): TeamShareEntry[] {
    const seen = new Set<string>();
    const result: TeamShareEntry[] = [];
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      const entry = this.entries[i]!;
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      result.push(entry);
    }
    return result;
  }

  /** 全部键（去重，按首次出现序）。 */
  keys(): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const entry of this.entries) {
      if (!seen.has(entry.key)) {
        seen.add(entry.key);
        result.push(entry.key);
      }
    }
    return result;
  }

  /**
   * 成员 turn 0 开局注入用摘要：列出已有键 + 各最新值前缀 + 写入者。
   * 空黑板返回 ""（调用方决定是否拼接注记）；值超 prefixLen 断前缀防 prompt 膨胀。
   * 同 key 多版本取最新值（与 read(key) 语义一致），键按首次出现序排列（与 keys() 一致）。
   */
  summary(maxEntries = 10, prefixLen = 30): string {
    if (this.entries.length === 0) return "";
    // Map 保序：key 按首次出现序插入，set 更新 value 不改变位置 → 遍历值即"键首次序 + 各键最新值"
    const latest = new Map<string, TeamShareEntry>();
    for (const entry of this.entries) {
      latest.set(entry.key, entry);
    }
    const lines: string[] = [];
    for (const entry of latest.values()) {
      if (lines.length >= maxEntries) break;
      const value = entry.value.length > prefixLen ? `${entry.value.slice(0, prefixLen)}…` : entry.value;
      lines.push(`- ${entry.key}（${entry.writer}）: ${value}`);
    }
    return lines.join("\n");
  }

  size(): number {
    return this.entries.length;
  }

  private appendLine(line: string): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      appendFileSync(this.filePath, line + "\n", "utf8");
    } catch (err) {
      logger.warn(`团队共享黑板落盘失败（仅内存可见）: ${this.filePath}`, err);
    }
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    let text: string;
    try {
      text = readFileSync(this.filePath, "utf8");
    } catch (err) {
      logger.warn(`团队共享黑板读取失败（按空黑板继续）: ${this.filePath}`, err);
      return;
    }
    for (const line of text.split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        const parsed = JSON.parse(line) as Partial<TeamShareEntry>;
        if (typeof parsed.key !== "string" || typeof parsed.writer !== "string") continue;
        const dedup = shareDedupKey(parsed as TeamShareEntry);
        if (this.seenDedup.has(dedup)) continue;
        this.seenDedup.add(dedup);
        this.entries.push(parsed as TeamShareEntry);
      } catch {
        // 坏行跳过（追加写并发时可能读到半行）。
      }
    }
  }
}
