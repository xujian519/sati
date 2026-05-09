import { createAgentSessionStateFromReplay, type AgentSession } from "../../agent/session/AgentSession.js";
import { createAgentSessionWithStorage, type CreateAgentSessionOptions } from "../../agent/session/createAgentSession.js";
import type { SessionMetadataValue } from "../transcript/TranscriptEntry.js";
import { SessionMetadataStore } from "../metadata/SessionMetadataStore.js";
import { createAgentProjectSessionStorage, type AgentProjectSessionStorageOptions } from "../storage/ProjectSessionStorage.js";
import { readTranscript } from "../transcript/TranscriptReader.js";
import { replayTranscriptEntries } from "../transcript/TranscriptReplay.js";

export type ResumeAgentSessionOptions = Omit<CreateAgentSessionOptions, "transcript" | "projectStorage"> & {
  projectStorage: Omit<AgentProjectSessionStorageOptions, "sessionId" | "now">;
};

export type ResumeAgentSessionResult = {
  session: AgentSession;
  transcriptPath: string;
  diagnostics: ReturnType<typeof replayTranscriptEntries>["diagnostics"];
  metadata: SessionMetadataValue;
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

  // Restore metadata into a SessionMetadataStore so downstream code
  // (adapter / listing) sees the latest state without rescanning.
  const metadataStore = new SessionMetadataStore({
    transcript: storage.transcript,
    sessionId: options.sessionId,
    now: options.dependencies.now,
  });
  metadataStore.restoreFromReplay(replay.metadata);

  return {
    session,
    transcriptPath: storage.transcriptPath,
    diagnostics: [...readResult.diagnostics, ...replay.diagnostics],
    metadata: metadataStore.getSnapshot(),
  };
}
