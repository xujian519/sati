import { resolve } from "node:path";
import { getPolitProjectChatDir } from "../../polit/index.js";
import { JsonlTranscriptWriter } from "../transcript/JsonlTranscriptWriter.js";

export type AgentProjectSessionStorageOptions = {
  projectRoot: string;
  politHome: string;
  sessionId: string;
  now?: () => Date;
};

export type AgentProjectSessionStorage = {
  chatDir: string;
  transcriptPath: string;
  toolResultsDir: string;
  /**
   * Per-session directory for file-history backups (C4 / F5). Backups land
   * at `<fileHistoryDir>/<sha16(filePath)>@v<version>` and survive process
   * restarts. The `FileHistoryStore` lazily creates the dir on first
   * `trackEdit`.
   */
  fileHistoryDir: string;
  transcript: JsonlTranscriptWriter;
};

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPolitProjectChatDir(options.projectRoot, options.politHome);
  const transcriptPath = resolve(chatDir, `${options.sessionId}.jsonl`);
  const toolResultsDir = resolve(chatDir, options.sessionId, "tool-results");
  const fileHistoryDir = resolve(chatDir, options.sessionId, "file-history");
  return {
    chatDir,
    transcriptPath,
    toolResultsDir,
    fileHistoryDir,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
    }),
  };
}
