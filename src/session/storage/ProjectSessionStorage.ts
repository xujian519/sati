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
  transcript: JsonlTranscriptWriter;
};

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPolitProjectChatDir(options.projectRoot, options.politHome);
  const transcriptPath = resolve(chatDir, `${options.sessionId}.jsonl`);
  const toolResultsDir = resolve(chatDir, options.sessionId, "tool-results");
  return {
    chatDir,
    transcriptPath,
    toolResultsDir,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
    }),
  };
}
