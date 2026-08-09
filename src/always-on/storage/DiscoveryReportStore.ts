import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createJsonlRunWriter, type JsonlRunWriter } from "../../fs/jsonl-run-writer.js";
import type { DiscoveryRunHistoryEvent } from "../protocol/types.js";
import { reportMarkdownPath, runEventsPath, type AlwaysOnPaths } from "./AlwaysOnPaths.js";

export class DiscoveryReportStore {
  private readonly runWriter: JsonlRunWriter;

  constructor(private readonly paths: AlwaysOnPaths) {
    this.runWriter = createJsonlRunWriter(runId => runEventsPath(this.paths, runId));
  }

  async writeReport(runId: string, markdown: string): Promise<string> {
    const filePath = reportMarkdownPath(this.paths, runId);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, markdown, "utf-8");
    return filePath;
  }

  /**
   * 追加一条 run 事件：按 runId 复用已打开的文件句柄（首次 open('a')，
   * 后续直接 write），避免每条事件重复 mkdir + open/close 三个 syscall。
   * 调用方保持 await 语义，事件顺序与落盘行为不变。
   */
  async appendRunEvent(runId: string, payload: Record<string, unknown>): Promise<void> {
    await this.runWriter.append(runId, `${JSON.stringify(payload)}\n`);
  }

  /** run 生命周期结束时主动关闭事件写入器（未调用则由空闲 TTL 兜底回收）。 */
  closeRun(runId: string): Promise<void> {
    return this.runWriter.close(runId);
  }

  async appendHistory(event: DiscoveryRunHistoryEvent): Promise<void> {
    await mkdir(dirname(this.paths.runHistoryFile), { recursive: true });
    await appendFile(this.paths.runHistoryFile, JSON.stringify(event) + "\n", "utf-8");
  }
}
