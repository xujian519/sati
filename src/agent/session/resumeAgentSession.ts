import { createAgentSessionStateFromReplay, type AgentSession } from "./AgentSession.js";
import { createAgentProjectSessionStorage, type AgentProjectSessionStorageOptions } from "./AgentSessionStorage.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../transcript/TranscriptReplay.js";
import type { CreateAgentSessionOptions } from "./createAgentSession.js";
import { createAgentSessionWithStorage } from "./createAgentSession.js";

export type ResumeAgentSessionOptions = Omit<CreateAgentSessionOptions, "transcript" | "projectStorage"> & {
  projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
};

export type ResumeAgentSessionResult = {
  session: AgentSession;
  transcriptPath: string;
  diagnostics: ReturnType<typeof replayTranscriptEntries>["diagnostics"];
};

export async function resumeAgentSession(options: ResumeAgentSessionOptions): Promise<ResumeAgentSessionResult> {
  const storage = createAgentProjectSessionStorage({
    ...options.projectStorage,
    sessionId: options.sessionId,
    now: options.dependencies.now,
  });
  const readResult = await readTranscript(storage.transcriptPath);
  const replay = replayTranscriptEntries(readResult.entries);
  const { session } = createAgentSessionWithStorage({
    ...options,
    projectStorage: options.projectStorage,
    transcript: storage.transcript,
    initialState: createAgentSessionStateFromReplay(options.sessionId, replay),
    replayEvents: replay.events,
  });

  return {
    session,
    transcriptPath: storage.transcriptPath,
    diagnostics: [...readResult.diagnostics, ...replay.diagnostics],
  };
}
