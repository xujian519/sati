import type { AgentTranscriptWriter } from "../transcript/TranscriptWriter.js";
import type { SessionMetadataValue } from "../transcript/TranscriptEntry.js";

export type SessionMetadataStoreOptions = {
  transcript: AgentTranscriptWriter;
  sessionId: string;
  now?: () => Date;
};

export class SessionMetadataStore {
  private readonly now: () => Date;
  private metadata: SessionMetadataValue = {};

  constructor(private readonly options: SessionMetadataStoreOptions) {
    this.now = options.now ?? (() => new Date());
  }

  getSnapshot(): SessionMetadataValue {
    return cloneMetadata(this.metadata);
  }

  async saveTitle(title: string, turnId = "metadata"): Promise<void> {
    await this.record(turnId, { title, updatedAt: this.now().toISOString() });
  }

  async saveAiTitle(aiTitle: string, turnId = "metadata"): Promise<void> {
    if (this.metadata.title) {
      await this.record(turnId, { aiTitle, updatedAt: this.now().toISOString() });
      return;
    }
    await this.record(turnId, { aiTitle, updatedAt: this.now().toISOString() });
  }

  async saveTag(tag: string, turnId = "metadata"): Promise<void> {
    await this.record(turnId, { tag, updatedAt: this.now().toISOString() });
  }

  async savePullRequest(
    linkedPullRequest: NonNullable<SessionMetadataValue["linkedPullRequest"]>,
    turnId = "metadata",
  ): Promise<void> {
    await this.record(turnId, { linkedPullRequest, updatedAt: this.now().toISOString() });
  }

  async saveMode(mode: NonNullable<SessionMetadataValue["mode"]>, turnId = "metadata"): Promise<void> {
    await this.record(turnId, { mode, updatedAt: this.now().toISOString() });
  }

  async record(turnId: string, metadata: SessionMetadataValue): Promise<void> {
    this.metadata = mergeMetadata(this.metadata, metadata);
    if (!this.options.transcript.recordSessionMetadata) {
      throw new Error("Transcript writer does not support session metadata entries.");
    }
    await this.options.transcript.recordSessionMetadata(this.options.sessionId, turnId, metadata);
  }
}

export function mergeMetadata(first: SessionMetadataValue, second: SessionMetadataValue): SessionMetadataValue {
  return {
    ...first,
    ...second,
    title: second.title ?? first.title,
    linkedPullRequest: second.linkedPullRequest ?? first.linkedPullRequest,
  };
}

function cloneMetadata(metadata: SessionMetadataValue): SessionMetadataValue {
  return {
    ...metadata,
    linkedPullRequest: metadata.linkedPullRequest ? { ...metadata.linkedPullRequest } : undefined,
  };
}
