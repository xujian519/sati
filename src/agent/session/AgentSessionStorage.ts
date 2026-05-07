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
  transcript: JsonlTranscriptWriter;
};

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPolitProjectChatDir(options.projectRoot, options.politHome);
  const transcriptPath = resolve(chatDir, `${options.sessionId}.jsonl`);
  return {
    chatDir,
    transcriptPath,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
    }),
  };
}
