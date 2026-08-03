/**
 * compactionGroups — extracted from CompactionEngine.ts (compaction summary pipeline).
 */

import type { CanonicalMessage } from "../../model/index.js";
import { collectToolNamesByCallId, isProtectedContextMessage } from "./protectedContext.js";

export function splitMessagesIntoCompactionGroups(
  messages: CanonicalMessage[],
): Array<{ index: number; messages: CanonicalMessage[] }> {
  const groups: Array<{ index: number; messages: CanonicalMessage[] }> = [];
  let current: CanonicalMessage[] = [];
  const flush = () => {
    if (current.length === 0) return;
    groups.push({ index: groups.length, messages: current });
    current = [];
  };

  for (const message of messages) {
    if (message.role === "user" && !isToolResultOnlyMessage(message)) {
      flush();
      groups.push({ index: groups.length, messages: [message] });
      continue;
    }
    if (message.role === "assistant") {
      flush();
      current = [message];
      continue;
    }
    current.push(message);
  }
  flush();
  return groups;
}

export function collectProtectedGroupIndexes(
  groups: Array<{ index: number; messages: CanonicalMessage[] }>,
  options: { protectedToolNames?: Iterable<string> } = {},
): Set<number> {
  const toolNamesByCallId = collectToolNamesByCallId(groups.flatMap(group => group.messages));
  const protectedIndexes = new Set<number>();
  for (const group of groups) {
    if (hasProtectedContextMessage(group.messages, toolNamesByCallId, options)) {
      protectedIndexes.add(group.index);
      // Compaction groups deliberately split tool cycles inside one user task
      // so older cycles can still be summarized. When a protected cycle is
      // retained, however, its initiating request must stay with it. Without
      // this, the generated summary can be immediately followed by an
      // assistant tool call, which violates providers' role ordering rules.
      const previous = groups[group.index - 1];
      if (previous && isStandaloneUserRequestGroup(previous.messages)) {
        protectedIndexes.add(previous.index);
      }
    }
  }
  return protectedIndexes;
}

export function moveTailBoundaryBeforeProtectedRequest(
  groups: Array<{ index: number; messages: CanonicalMessage[] }>,
  tailStartTurn: number,
  protectedToolNames: Iterable<string>,
): number {
  if (tailStartTurn <= 0 || tailStartTurn >= groups.length) {
    return tailStartTurn;
  }
  const toolNamesByCallId = collectToolNamesByCallId(groups.flatMap(group => group.messages));
  const firstTailGroup = groups[tailStartTurn]!;
  const precedingGroup = groups[tailStartTurn - 1]!;
  if (
    hasProtectedContextMessage(firstTailGroup.messages, toolNamesByCallId, { protectedToolNames }) &&
    isStandaloneUserRequestGroup(precedingGroup.messages)
  ) {
    return precedingGroup.index;
  }
  return tailStartTurn;
}

function hasProtectedContextMessage(
  messages: CanonicalMessage[],
  toolNamesByCallId: ReadonlyMap<string, string>,
  options: { protectedToolNames?: Iterable<string> } = {},
): boolean {
  return messages.some(message =>
    isProtectedContextMessage(message, {
      ...options,
      toolNamesByCallId,
    }),
  );
}

function isStandaloneUserRequestGroup(messages: CanonicalMessage[]): boolean {
  return messages.length === 1 && messages[0]!.role === "user" && !isToolResultOnlyMessage(messages[0]!);
}

function isToolResultOnlyMessage(message: CanonicalMessage): boolean {
  return (
    message.content.length > 0 &&
    message.content.every(block => block.type === "tool_result" || block.type === "tool_result_reference")
  );
}

export function findTailStartTurn(
  turns: Array<{ index: number; messages: CanonicalMessage[] }>,
  tailTokenBudget: number,
  minTailMessagesInput: number,
  estimateTurnTokens: (turnMessages: CanonicalMessage[]) => number,
): number {
  if (turns.length === 0) {
    return 0;
  }

  const softBudget = Math.max(1, Math.floor(tailTokenBudget * 1.5));
  const requestedFloor = Math.max(1, Math.floor(minTailMessagesInput));
  const totalMessages = turns.reduce((sum, turn) => sum + turn.messages.length, 0);
  const minTailMessages =
    requestedFloor <= 1 ? 1 : Math.min(8, Math.max(requestedFloor, Math.floor(totalMessages * 0.1) || requestedFloor));

  let accumulated = 0;
  let keptMessages = 0;
  let cutIndex = turns.length;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index]!;
    const turnTokens = estimateTurnTokens(turn.messages);
    const wouldExceed = accumulated + turnTokens > softBudget;
    if (wouldExceed && keptMessages >= minTailMessages) {
      break;
    }
    accumulated += turnTokens;
    keptMessages += turn.messages.length;
    cutIndex = index;
  }

  if (cutIndex <= 0 && accumulated > 0 && accumulated <= softBudget) {
    let rawAccumulated = 0;
    let rawKeptMessages = 0;
    cutIndex = turns.length;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      const turn = turns[index]!;
      const turnTokens = estimateTurnTokens(turn.messages);
      if (rawAccumulated + turnTokens > tailTokenBudget && rawKeptMessages >= minTailMessages) {
        break;
      }
      rawAccumulated += turnTokens;
      rawKeptMessages += turn.messages.length;
      cutIndex = index;
    }
  }

  if (cutIndex <= 0 && turns.length > 1) {
    let messageCount = 0;
    cutIndex = turns.length;
    for (let index = turns.length - 1; index >= 0; index -= 1) {
      messageCount += turns[index]!.messages.length;
      cutIndex = index;
      if (messageCount >= minTailMessages) {
        break;
      }
    }
  }

  return Math.max(0, cutIndex);
}
