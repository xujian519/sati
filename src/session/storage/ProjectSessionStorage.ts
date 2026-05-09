import { resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { JsonlTranscriptWriter } from "../transcript/JsonlTranscriptWriter.js";

export type AgentProjectSessionStorageOptions = {
  projectRoot: string;
  pilotHome: string;
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
  /**
   * Per-session directory for subagent sidechain transcripts (C3 §6.3).
   * Each forked subagent gets its own `<subagentId>.jsonl` here.
   */
  subagentsDir: string;
  subagentTranscriptPath(subagentId: string): string;
  transcript: JsonlTranscriptWriter;
};

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const transcriptPath = resolve(chatDir, `${options.sessionId}.jsonl`);
  const toolResultsDir = resolve(chatDir, options.sessionId, "tool-results");
  const fileHistoryDir = resolve(chatDir, options.sessionId, "file-history");
  const subagentsDir = resolve(chatDir, options.sessionId, "subagents");
  const subagentTranscriptPath = (subagentId: string): string =>
    resolve(subagentsDir, `${subagentId}.jsonl`);
  return {
    chatDir,
    transcriptPath,
    toolResultsDir,
    fileHistoryDir,
    subagentsDir,
    subagentTranscriptPath,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
      subagentTranscriptPath,
    }),
  };
}
