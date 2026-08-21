/**
 * WorkspaceLedger — the externalized workspace state (J-Space ledger).
 *
 * A pure state machine with no I/O. It mirrors the J-Space controller's `note`
 * semantics: every edit is validated, malformed edits are refused, and a mixed
 * call never drops an independent valid edit. The ledger is *derived* from the
 * transcript (see WorkspaceLedgerReader) and re-injected before each model call,
 * so it survives compaction.
 *
 * Invariants enforced here:
 *   - A ledger opens only with both Goal and Next.
 *   - Next is never empty on an open ledger.
 *   - Verified entries are numbered append-only and each requires a verifier
 *     plus a coverage clause.
 *   - Open entries are numbered, require a settle-by test, and their number is
 *     never reused after they close.
 *   - An Open entry closes only against a checkpoint recorded in the same call.
 *   - Core holds at most two live entries; replacing one is an explicit swap.
 */

export const MAX_LIVE_CORE = 2;

export type WorkspaceCoreEntry = {
  text: string;
  live: boolean;
};

export type WorkspaceVerifiedEntry = {
  number: number;
  text: string;
  by: string;
  /** Open question number closed by this checkpoint (number never reused). */
  closesOpen?: number;
};

export type WorkspaceOpenEntry = {
  number: number;
  text: string;
  settledBy: string;
};

export type WorkspaceLedgerState = {
  goal: string;
  core: WorkspaceCoreEntry[];
  verified: WorkspaceVerifiedEntry[];
  open: WorkspaceOpenEntry[];
  next: string;
};

/** Partial, multi-field note input (mirrors the controller's `note` command). */
export type WorkspaceNoteInput = {
  goal?: string;
  next?: string;
  core?: string;
  coreSlot?: 1 | 2;
  check?: string;
  by?: string;
  open?: string;
  settledBy?: string;
  close?: number;
};

export type WorkspaceNoteResult = {
  state: WorkspaceLedgerState;
  /** Human-readable descriptions of rejected edits. */
  rejected: string[];
  /** True when at least one edit was applied. */
  changed: boolean;
};

/** Rendered `<workspace-state>` block injected before each model call. */
export type WorkspaceLedgerBlock = {
  block: string;
  /** True when the ledger is empty (nothing to inject). */
  empty: boolean;
};

const SECTION_HEADING = /^##\s+/;

/**
 * A verification claim without a stated coverage is the failure the ledger
 * exists to prevent: "verified" without scope is a mood, not a result. The
 * ledger enforces coverage on the `by` field.
 */
export const COVERAGE_RE =
  /(?:all|each|every|cases?|inputs?|samples?|bounds?|boundaries|edges?|random(?:ized|ised)?|files?|modules?|sections?|lines?|scenarios?|environments?|platforms?|datasets?|records?|routes?|commands?|branches?|ranges?|including|through|up\s+to|Windows|Linux|macOS|Chrome|Firefox|Safari)\b|\b(?:Python|Node(?:\.js)?)\s*\d|\bn\s*[<≤=]\s*\d|(?:覆盖|全部|所有|每个|每条|各条|每项|逐一|逐条|边界|上下限|上限|下限|输入|用例|文件|目录|模块|章节|区段|分段|行数|行号|场景|平台|环境|浏览器|数据集|记录|路径|路由|命令|分支|范围|包括|包含|至多|至少|最多|最少|随机|样本|样例|截至)/i;

export function emptyWorkspaceLedger(): WorkspaceLedgerState {
  return { goal: "", core: [], verified: [], open: [], next: "" };
}

export function cloneWorkspaceLedgerState(state: WorkspaceLedgerState): WorkspaceLedgerState {
  return {
    goal: state.goal,
    core: state.core.map(entry => ({ ...entry })),
    verified: state.verified.map(entry => ({ ...entry })),
    open: state.open.map(entry => ({ ...entry })),
    next: state.next,
  };
}

export function isWorkspaceLedgerOpen(state: WorkspaceLedgerState): boolean {
  return state.goal.length > 0 || state.next.length > 0;
}

export function nextVerifiedNumber(state: WorkspaceLedgerState): number {
  return maxNumber(state.verified.map(entry => entry.number)) + 1;
}

/**
 * Allocate an Open id that is never reused. It scans both active open numbers
 * and the closed-open numbers recorded on Verified entries (closesOpen).
 */
export function nextOpenNumber(state: WorkspaceLedgerState): number {
  const numbers = state.open.map(entry => entry.number);
  for (const entry of state.verified) {
    if (entry.closesOpen !== undefined) {
      numbers.push(entry.closesOpen);
    }
  }
  return maxNumber(numbers) + 1;
}

/**
 * Apply a multi-field note to the ledger. Valid edits are applied, invalid
 * edits are reported as rejected, and independent valid edits are never dropped
 * because a sibling edit was rejected.
 */
export function applyWorkspaceNote(state: WorkspaceLedgerState, note: WorkspaceNoteInput): WorkspaceNoteResult {
  const next: WorkspaceLedgerState = cloneLedger(state);
  const rejected: string[] = [];
  const hasGoal = note.goal !== undefined && note.goal.trim().length > 0;
  const hasNext = note.next !== undefined && note.next.trim().length > 0;

  if (!isWorkspaceLedgerOpen(next)) {
    if (!(hasGoal && hasNext)) {
      rejected.push("opening the ledger requires both Goal and Next.");
      return { state: next, rejected, changed: false };
    }
  }

  if (note.goal !== undefined) {
    const value = cleanScalar(note.goal);
    if (value === null) {
      rejected.push("Goal must be a single non-empty line.");
    } else if (SECTION_HEADING.test(value)) {
      rejected.push("Goal must not begin with a ledger section heading.");
    } else {
      next.goal = value;
    }
  }

  if (note.core !== undefined) {
    applyCoreEdit(next, note, rejected);
  } else if (note.coreSlot !== undefined) {
    rejected.push("coreSlot requires a core entry.");
  }

  let checkRecorded = false;
  if (note.check !== undefined) {
    const check = cleanScalar(note.check);
    const by = note.by !== undefined ? cleanScalar(note.by) : null;
    if (check === null) {
      rejected.push("check must be a single non-empty line.");
    } else if (by === null) {
      rejected.push("A checkpoint requires --by (what verified it).");
    } else if (!COVERAGE_RE.test(by)) {
      rejected.push("A checkpoint must state its coverage (what the verification covered).");
    } else {
      const number = nextVerifiedNumber(next);
      next.verified.push({ number, text: check, by });
      checkRecorded = true;
    }
  } else if (note.by !== undefined) {
    rejected.push("by requires a check.");
  }

  if (note.open !== undefined) {
    const open = cleanScalar(note.open);
    const settledBy = note.settledBy !== undefined ? cleanScalar(note.settledBy) : null;
    if (open === null) {
      rejected.push("open must be a single non-empty line.");
    } else if (settledBy === null) {
      rejected.push("An open question requires --settled-by (the test that would settle it).");
    } else {
      const number = nextOpenNumber(next);
      next.open.push({ number, text: open, settledBy });
    }
  } else if (note.settledBy !== undefined) {
    rejected.push("settledBy requires an open question.");
  }

  if (note.close !== undefined) {
    if (!checkRecorded) {
      rejected.push("An Open entry closes only against a recorded checkpoint.");
    } else {
      const index = next.open.findIndex(entry => entry.number === note.close);
      if (index === -1) {
        rejected.push(`no open question numbered ${note.close}.`);
      } else {
        next.open.splice(index, 1);
        const last = next.verified[next.verified.length - 1];
        if (last !== undefined) {
          last.closesOpen = note.close;
        }
      }
    }
  }

  if (note.next !== undefined) {
    const value = cleanScalar(note.next);
    if (value === null) {
      rejected.push("Next must be a single non-empty line.");
    } else {
      next.next = value;
    }
  }

  if (isWorkspaceLedgerOpen(next) && next.next.length === 0) {
    rejected.push("Next is never empty. A ledger with no next action is a ledger you have stopped using.");
  }

  const changed = !deepEqualWorkspaceLedger(state, next);
  return { state: changed ? next : state, rejected, changed };
}

function applyCoreEdit(state: WorkspaceLedgerState, note: WorkspaceNoteInput, rejected: string[]): void {
  const text = note.core !== undefined ? cleanScalar(note.core) : null;
  if (text === null) {
    rejected.push("Core entry must be a single non-empty line.");
    return;
  }
  if (!text.includes("—") && !text.includes(" - ")) {
    rejected.push("Mentioning is not loading: a core entry is `name — the one fact that makes it matter`.");
    return;
  }

  if (note.coreSlot === undefined) {
    if (state.core.some(entry => entry.text === text)) {
      rejected.push("that core entry is already present.");
      return;
    }
    state.core.push({ text, live: state.core.filter(entry => entry.live).length < MAX_LIVE_CORE });
    return;
  }

  const live = state.core.filter(entry => entry.live);
  const parked = state.core.filter(entry => !entry.live);
  const slotIndex = note.coreSlot - 1;
  if (live.some(entry => entry.text === text)) {
    rejected.push("that core entry is already live.");
    return;
  }
  if (slotIndex >= MAX_LIVE_CORE || slotIndex > live.length) {
    rejected.push(`live core slot ${note.coreSlot} does not exist.`);
    return;
  }
  // Promote the entry into a live slot. Drop any parked copy so promoting a
  // parked concept never leaves a duplicate, and demote the displaced live
  // entry (live:false) so the "at most two live" invariant holds.
  const newEntry: WorkspaceCoreEntry = { text, live: true };
  const parkedWithout = parked.filter(entry => entry.text !== text);
  const displaced = live[slotIndex];
  if (slotIndex === live.length) {
    state.core = [...live, newEntry, ...parkedWithout];
  } else if (displaced !== undefined) {
    const nextLive = live.map((entry, index) => (index === slotIndex ? newEntry : entry));
    state.core = [...nextLive, ...parkedWithout, { ...displaced, live: false }];
  }
}

function cleanScalar(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (value.includes("\n") || value.includes("\r")) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function maxNumber(numbers: number[]): number {
  return numbers.length === 0 ? 0 : Math.max(...numbers);
}

function cloneLedger(state: WorkspaceLedgerState): WorkspaceLedgerState {
  return cloneWorkspaceLedgerState(state);
}

function deepEqualWorkspaceLedger(a: WorkspaceLedgerState, b: WorkspaceLedgerState): boolean {
  return (
    a.goal === b.goal &&
    a.next === b.next &&
    JSON.stringify(a.core) === JSON.stringify(b.core) &&
    JSON.stringify(a.verified) === JSON.stringify(b.verified) &&
    JSON.stringify(a.open) === JSON.stringify(b.open)
  );
}

/**
 * Render the ledger as a compact, model-visible `<workspace-state>` block.
 * Returns empty=true when the ledger has no content worth injecting.
 */
export function renderWorkspaceLedgerBlock(state: WorkspaceLedgerState): WorkspaceLedgerBlock {
  if (!isWorkspaceLedgerOpen(state)) {
    return { block: "", empty: true };
  }
  const lines: string[] = ["<workspace-state>"];
  lines.push(`Goal: ${state.goal || "(not set)"}`);
  const live = state.core.filter(entry => entry.live);
  if (live.length > 0) {
    lines.push(`Core (shared hub — read these, write once): ${live.map(entry => entry.text).join(" | ")}`);
    lines.push("  Resolve any divergent value at the hub, not in a branch.");
  } else {
    lines.push(`Core: ${"(none)"}`);
  }
  const extra = state.core.filter(entry => !entry.live);
  if (extra.length > 0) {
    lines.push(`  (parked: ${extra.map(entry => entry.text).join(" | ")})`);
  }
  const lastVerified = state.verified[state.verified.length - 1];
  lines.push(
    `Verified: ${lastVerified ? `✓${pad(lastVerified.number)} ${lastVerified.text} — verified by: ${lastVerified.by}` : "(none yet)"}`,
  );
  if (state.verified.length > 1) {
    lines.push(`  (${state.verified.length - 1} earlier, append-only)`);
  }
  for (const entry of state.open.slice(0, 2)) {
    lines.push(`Open: ?${pad(entry.number)} ${entry.text} — settled by: ${entry.settledBy}`);
  }
  if (state.open.length > 2) {
    lines.push(`  (+${state.open.length - 2} more in the ledger)`);
  }
  lines.push(`Next: ${state.next || "(not set)"}`);
  lines.push("</workspace-state>");
  return { block: lines.join("\n"), empty: false };
}

/**
 * Render the parent's live `Core` anchors as a `<workspace-core>` directive
 * prefix for a forked subagent (broadcast hub). Returns undefined when there
 * are no live anchors, so the subagent directive is unchanged.
 */
export function renderWorkspaceCoreDirective(state: WorkspaceLedgerState): string | undefined {
  const live = state.core.filter(entry => entry.live);
  if (live.length === 0) return undefined;
  const lines = [
    "<workspace-core>",
    "Shared anchors from the parent workspace (write once, read many).",
    ...live.map(entry => `- ${entry.text}`),
    "Read these instead of reconstructing locally; resolve any conflict at the parent hub.",
    "</workspace-core>",
  ];
  return lines.join("\n");
}

function pad(number: number): string {
  return String(number).padStart(2, "0");
}
