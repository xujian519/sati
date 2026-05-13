import test from "node:test";
import assert from "node:assert/strict";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { buildPostCompactMessages, truncateHead } from "../../../src/context/compaction/CompactionEngine.js";
import { findLastCompactBoundaryIndex } from "../../../src/session/transcript/TranscriptReplay.js";
import { normalizeModelError } from "../../../src/model/errors/normalizeModelError.js";
import {
  COMPACT_BOUNDARY_SCENARIOS,
  POST_COMPACT_ORDER_SCENARIOS,
  PTL_CLASSIFICATION_SCENARIOS,
  ROUGH_TOKEN_SCENARIOS,
  TRUNCATE_HEAD_SCENARIOS,
} from "../../fixtures/context/dual-parity/legacyParityScenarios.js";
import type {
  AgentControlBoundaryTranscriptEntry,
  AgentTranscriptEntry,
} from "../../../src/session/transcript/TranscriptEntry.js";
import type { CanonicalMessage } from "../../../src/model/index.js";

for (const scenario of ROUGH_TOKEN_SCENARIOS) {
  test(`legacy parity / rough token / ${scenario.id}`, () => {
    if (scenario.parityStatus !== "compare") return;
    const manager = new TokenBudgetManager();
    const tokens = manager.estimateTextTokens(scenario.text);
    assert.equal(tokens, scenario.expectedTokens, `[${scenario.source}]`);
  });
}

for (const scenario of COMPACT_BOUNDARY_SCENARIOS) {
  test(`legacy parity / compact boundary slice / ${scenario.id}`, () => {
    if (scenario.parityStatus !== "compare") return;
    const entries: AgentTranscriptEntry[] = scenario.entries.map((entry, index) => {
      const base = {
        sessionId: "s",
        turnId: "t",
        sequence: index,
        createdAt: "2026-01-01T00:00:00.000Z",
      } as const;
      if (entry.type === "compact_boundary") {
        const e: AgentControlBoundaryTranscriptEntry = {
          ...base,
          type: "control_boundary",
          boundary: {
            kind: "compact",
            subtype: "compact_boundary",
            compactMetadata: { trigger: "manual", preTokens: 100 },
          },
        };
        return e;
      }
      if (entry.type === "user") {
        return {
          ...base,
          type: "accepted_input",
          messages: [{ role: "user", content: [{ type: "text", text: entry.tag }] }],
        };
      }
      if (entry.type === "assistant") {
        return {
          ...base,
          type: "assistant_message",
          message: { role: "assistant", content: [{ type: "text", text: entry.tag }] },
        };
      }
      return {
        ...base,
        type: "turn_result",
        result: {
          type: "success",
          sessionId: "s",
          turnId: "t",
          stopReason: "completed",
          usage: {},
          permissionDenials: [],
          turns: 1,
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:00:00.000Z",
        },
      };
    });
    const idx = findLastCompactBoundaryIndex(entries);
    assert.equal(idx, scenario.expectedBoundaryIndex, `[${scenario.source}]`);
  });
}

for (const scenario of POST_COMPACT_ORDER_SCENARIOS) {
  test(`legacy parity / post compact order / ${scenario.id}`, () => {
    if (scenario.parityStatus !== "compare") return;
    const tag = (text: string): CanonicalMessage => ({ role: "user", content: [{ type: "text", text }] });
    const result = {
      trigger: "manual" as const,
      preTokens: 0,
      boundaryMarker: tag("B"),
      summaryMessage: scenario.hasSummary
        ? ({ role: "assistant" as const, content: [{ type: "text" as const, text: "S" }] })
        : undefined,
      messagesToKeep: [tag("K")],
      attachments: scenario.hasAttachments ? [tag("A")] : [],
      hookResults: scenario.hasHooks ? [tag("H")] : [],
      diagnostics: [],
    };
    const out = buildPostCompactMessages(result);
    assert.deepEqual(
      out.map((m) => (m.content[0] as { text: string }).text),
      scenario.expectedTags,
      `[${scenario.source}]`,
    );
  });
}

for (const scenario of TRUNCATE_HEAD_SCENARIOS) {
  test(`legacy parity / truncate head / ${scenario.id}`, () => {
    if (scenario.parityStatus !== "compare") return;
    const messages: CanonicalMessage[] = Array.from({ length: scenario.count }, (_, index) => ({
      role: "user",
      content: [{ type: "text", text: `m${index}` }],
    }));
    const out = truncateHead(messages, scenario.keepRatio);
    assert.deepEqual(
      out.map((m) => (m.content[0] as { text: string }).text),
      scenario.expectedKeptTags,
      `[${scenario.source}]`,
    );
  });
}

for (const scenario of PTL_CLASSIFICATION_SCENARIOS) {
  test(`legacy parity / ptl classification / ${scenario.id}`, () => {
    if (scenario.parityStatus !== "compare") return;
    const error = normalizeModelError(
      scenario.protocol === "anthropic" ? "anthropic-main" : "openai-main",
      scenario.protocol,
      new Error(scenario.message),
      scenario.status,
    );
    assert.equal(error.code, scenario.expectedCode, `[${scenario.source}]`);
    assert.equal(
      Boolean(error.recoverableViaCompact),
      scenario.expectedRecoverableViaCompact,
      `[${scenario.source}]`,
    );
  });
}
