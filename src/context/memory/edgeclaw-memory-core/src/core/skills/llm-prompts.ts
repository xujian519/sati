// llm-extraction 的提示词模板与 prompt 构造（从 llm-extraction.ts 拆出，G2/G3 聚类，逐字搬移）。
// 全部为数据/纯函数（字符串模板与 JSON 构造），无 IO。Llm* 类型 type-only 引自
// llm-extraction.js（编译后擦除，无运行时环）。
import { normalizeWhitespace, truncate, truncateForPrompt, uniqueStrings } from "./llm-normalizers.js";
import { splitProfileFacts, stripMarkdownSyntax } from "./llm-hints.js";
import type {
  LlmDreamClusterPlanInput,
  LlmDreamClusterPlanOutput,
  LlmDreamClusterRefineInput,
  LlmDreamClusterRefineOutput,
  LlmDreamFileGlobalPlanInput,
  LlmDreamFileGlobalPlanOutput,
  LlmDreamFileProjectRewriteInput,
  LlmDreamFileProjectRewriteOutput,
  LlmDreamProjectMetaReviewInput,
  LlmDreamProjectMetaReviewOutput,
  LlmGeneralProjectMetaMergeInput,
  LlmGeneralProjectMetaMergeOutput,
} from "./llm-extraction.js";
import type {
  MemoryCandidate,
  MemoryMessage,
  MemoryUserSummary,
  ProjectIdentityHint,
  ProjectMetaRecord,
  ProjectShortlistCandidate,
} from "../types.js";

const DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS = 600_000;
const DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS = 300_000;
const DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS = 180_000;
const DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS = 180_000;
const DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS = 120_000;
const DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS = 120_000;
const DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS = 45_000;
const DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS = 75_000;

const MEMORY_CLASSIFICATION_SYSTEM_PROMPT = `
You classify one focus user turn for a long-term memory indexing pipeline.

You are only deciding categories. Do not generate the memory file yet.

Rules:
- Base the decision on the focus user turn first.
- You may use the neighboring user/assistant turns only to disambiguate the focus turn.
- Assistant text is context only. Never classify something that exists only in assistant wording.
- A turn can match multiple categories, but at most once per category.
- Allowed categories:
  - user: cross-project durable personal identity/background facts about who the user is, such as name, profession, long-term role context, life background, or durable relationship context.
  - project: durable current-project facts such as what the project is, goals, scope, important progress, blockers, risks, key decisions.
  - feedback: current-project collaboration rules, delivery rules, output structure, title/body template rules, confirmed style guidance, language rules, and file/tool boundaries.
- Identity test: only use user when the focus turn is describing the user as a person.
- Override test: if another project could reasonably override this rule or preference, it is not user; classify it as feedback.
- Output test: if the turn is constraining how the assistant should reply, write, format, deliver, or touch files/tools, classify it as feedback.
- Project memory should prefer stable facts. Do not classify short-lived time-flow updates, percentages, or fleeting scheduling notes as project memory unless they carry a durable blocker/risk/fact.
- If the user explicitly says "请记住", "帮我记住", or "remember this", treat that as a stronger signal for durable memory. This is still inferred from the visible user text only.
- If nothing durable should be remembered, return should_store=false and labels=[].
- Return JSON only.

Use this exact JSON shape:
{
  "should_store": true,
  "labels": [
    {
      "type": "user | project | feedback",
      "reason": "why this category applies",
      "evidence": "short quote or evidence summary from the focus turn"
    }
  ]
}
`.trim();

const USER_NOTE_CREATE_SYSTEM_PROMPT = `
You create one append-only user memory note from a focus user turn.

Rules:
- Create at most one user note.
- The note must capture only durable cross-project personal identity/background information about who the user is.
- Keep only long-lived identity facts such as name, profession, stable role context, life background, or durable relationship context.
- Do not include language choices, answer structure, formatting habits, style preferences, file boundaries, tool boundaries, or project-specific collaboration rules.
- One note should express one durable identity/background fact rather than a full profile rewrite.
- The visible output language must follow the dominant user language in the focus user turn and neighboring user turns.
- If the surrounding dialogue mixes languages, prefer the focus user turn language first, then the nearest neighboring user language.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- Keep the note readable markdown.
- Do not force the note into a fixed profile template. Use headings only when they genuinely help readability.
- Return JSON only.

Use this exact JSON shape:
{
  "skip": false,
  "reason": "",
  "name": "short user-memory title",
  "description": "one-line description",
  "markdown": "markdown body"
}
`.trim();

const PROJECT_NOTE_CREATE_SYSTEM_PROMPT = `
You create one append-only project memory note from a focus user turn.

Rules:
- Create at most one project note.
- The note belongs to the current project only.
- Capture durable project facts: what the project is, stable scope, goals, key progress, blockers, risks, important decisions, important next steps.
- Do not reduce the note to a vague status line.
- Do not focus on highly volatile percentages, fleeting schedules, or trivial short-term updates unless they reveal a durable blocker/risk/fact.
- The visible output language must follow the dominant user language in the focus user turn and neighboring user turns.
- If the surrounding dialogue mixes languages, prefer the focus user turn language first, then the nearest neighboring user language.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- Keep the note readable markdown.
- Prefer meaningful headings when useful, such as: ## Summary, ## Current Stage, ## Constraints, ## Blockers, ## Next Steps, ## Timeline, ## Notes.
- Return JSON only.

Use this exact JSON shape:
{
  "skip": false,
  "reason": "",
  "name": "short project-memory title",
  "description": "one-line description",
  "markdown": "markdown body"
}
`.trim();

const FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT = `
You create one append-only feedback memory note from a focus user turn.

Rules:
- Create at most one feedback note.
- The note belongs to the current project only.
- Use feedback for collaboration rules, delivery order, style constraints, title/body template rules, confirmed output expectations, language rules, and file/tool boundaries.
- The visible output language must follow the dominant user language in the focus user turn and neighboring user turns.
- If the surrounding dialogue mixes languages, prefer the focus user turn language first, then the nearest neighboring user language.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- Keep the note readable markdown.
- Prefer meaningful headings when useful, especially: ## Rule, ## Why, ## How To Apply, ## Notes.
- Return JSON only.

Use this exact JSON shape:
{
  "skip": false,
  "reason": "",
  "name": "short feedback-memory title",
  "description": "one-line description",
  "markdown": "markdown body"
}
`.trim();

const USER_PROFILE_REWRITE_SYSTEM_PROMPT = `
You rewrite the single "身份背景" section of a global user profile for a conversational memory system.

Rules:
- Return JSON only.
- The existing profile markdown is the previous draft. The incoming user notes are the newest evidence.
- Rewrite the section from scratch. Do not append blindly, and do not keep duplicate or near-duplicate facts just because they already exist.
- Keep only durable personal identity/background information that should persist across future sessions.
- If old profile content conflicts with newer, clearer incoming evidence, prefer the newer evidence and rewrite the section accordingly.
- If the incoming evidence only describes reply preferences, formatting habits, style choices, language choices, file/tool boundaries, or project collaboration rules, do not include them in the rewritten section.
- Do not include project progress, project-specific collaboration rules, deadlines, blockers, or temporary tasks.
- Keep the language aligned with the user's language in the incoming content.
- "identity_background_markdown" must contain only the markdown content that belongs under the "## 身份背景" heading.
- Do not include the heading itself.
- Prefer concise bullet-list markdown when possible.
- For every incoming user note, report whether its durable content was actually incorporated into the rewritten section.
- Include a "note_absorption" array with one entry per incoming user note, in the same order as "incoming_user_notes". Use the note's index in that array as "note_index".
- Mark "absorbed": true ONLY when the note's durable content is genuinely represented in "identity_background_markdown". Notes excluded by the rules above (reply preferences, style choices, collaboration rules, progress, deadlines, etc.) must be "absorbed": false.

Use this exact JSON shape:
{
  "identity_background_markdown": "- ...",
  "note_absorption": [{"note_index": 0, "absorbed": true}, {"note_index": 1, "absorbed": false}]
}
`.trim();

const STABLE_FORMAL_PROJECT_ID_PATTERN = /^project_[a-z0-9]+$/;

const DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT = `
You are the Dream global audit planner for a file-memory system.

Your job is to inspect the current project's metadata and memory files, then produce a single executable reorganization plan for that current project.

Rules:
- Use only the supplied current-project metadata and memory file snapshots as evidence.
- Do not invent projects, files, facts, or merges that are not supported by the provided memory files.
- This runtime has exactly one top-level current project for the active workspace.
- Do not create extra sibling projects, tmp projects, or umbrella projects.
- Decide the final file-level organization for the current project before any rewrite happens.
- Natural-language output fields must follow the dominant language already present in the supplied records and project metas.
- If the supplied evidence is mainly Chinese, write summaries, project_name, description, and any other natural-language output in Chinese.
- Keys and enums must remain in English.
- Multiple Project/*.md and Feedback/*.md files under the current project are expected and correct.
- If two explicit project names appear in the memories, treat them as alternative names, phases, or topic labels inside the same current project unless the evidence clearly says they are unrelated noise that should be deleted.
- You may:
  - rewrite current-project metadata
  - merge redundant files within the current project
  - keep multiple files when they represent distinct durable memories within the current project
  - delete old files only when their durable content is fully absorbed elsewhere
- If you consolidate files that use different project labels inside the same current project, keep project_name user-recognizable.
- Each retained entry id must appear in exactly one output project.
- deleted_entry_ids should only include files that are redundant, superseded, or absorbed by other rewritten files.
- deleted_project_ids should stay empty in current-project mode.
- Keep project names user-recognizable.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short audit summary",
  "duplicate_topic_count": 0,
  "conflict_topic_count": 0,
  "projects": [
    {
      "plan_key": "stable planner-local key",
      "target_project_id": "current_project",
      "project_name": "final project name",
      "description": "final project description",
      "status": "active",
      "merge_reason": "",
      "evidence_entry_ids": ["Project/current-stage.md"],
      "retained_entry_ids": ["Project/foo.md", "Feedback/bar.md"]
    }
  ],
  "deleted_project_ids": [],
  "deleted_entry_ids": ["Feedback/old.md"]
}
`.trim();

const DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT = `
You are the Dream project rewrite engine for a file-memory system.

Your job is to rewrite one final project from the supplied project and feedback memory files.

Rules:
- Use only the supplied records as evidence.
- Do not create a project-level summary file.
- Preserve atomic memory granularity: output a small set of project files and feedback files.
- Merge only when files are clearly redundant or conflicting enough that one cleaner file is better.
- Keep the supplied final project boundary and final project name. Do not broaden it into a more abstract umbrella project.
- Natural-language output fields must follow the dominant language already present in the supplied records and current project meta.
- If the supplied evidence is mainly Chinese, write project_meta fields and all project/feedback body fields in Chinese.
- Keys and enums must remain in English.
- Project files must describe project state: stage, decisions, constraints, next steps, blockers, timeline, notes.
- Feedback files must describe collaboration rules: rule, why, how_to_apply, notes.
- deleted_entry_ids should only include source files that are fully absorbed by rewritten files or are redundant.
- Every rewritten file must cite at least one source_entry_id from the supplied records.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short rewrite summary",
  "project_meta": {
    "project_name": "final project name",
    "description": "final project description",
    "status": "active"
  },
  "files": [
    {
      "type": "project",
      "name": "current-stage",
      "description": "current project state",
      "source_entry_ids": ["Project/a.md"],
      "stage": "current stage",
      "decisions": ["decision"],
      "constraints": ["constraint"],
      "next_steps": ["next step"],
      "blockers": ["blocker"],
      "timeline": ["timeline item"],
      "notes": ["note"]
    },
    {
      "type": "feedback",
      "name": "delivery-rule",
      "description": "delivery preference",
      "source_entry_ids": ["Feedback/b.md"],
      "rule": "the rule",
      "why": "why it matters",
      "how_to_apply": "when to apply it",
      "notes": ["note"]
    }
  ],
  "deleted_entry_ids": ["Project/obsolete.md"]
}
`.trim();

const GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT = `
You are the General Dream project-meta merge planner for a file-memory system.

Your job is to inspect all General project metadata records and decide which project nodes clearly describe the same real project.

Rules:
- Use only the supplied project metadata records as evidence.
- Be conservative. If there is any meaningful uncertainty, do not merge.
- Merge only when multiple project metas clearly refer to the same real project, same ongoing workstream, same external mirrored project identity, or an obvious alias/rename of the same project.
- Do not merge merely because projects share a domain, platform, customer type, content format, date, model, workflow, or broad business category.
- Do not merge separate named workstreams with different goals or deliverables.
- Example: "GBX-A 20260423 HoneydewPulse" and "GBX-B 20260423 ClinicFlow" must remain separate because they name different projects with different targets.
- For external mirrors, matching source_workspace_path plus source_project_id is strong evidence for merging.
- keeper_project_id and every duplicate_project_id must be one of the supplied project ids.
- A project id may appear in at most one merge group.
- The keeper must not appear in duplicate_project_ids.
- Return an empty merge_groups array when no merge is clearly justified.
- Natural-language output fields should follow the dominant language already present in the supplied project metas.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short merge planning summary",
  "merge_groups": [
    {
      "keeper_project_id": "project id to keep",
      "duplicate_project_ids": ["project id to merge into keeper"],
      "reason": "specific evidence that these metas are the same real project"
    }
  ]
}
`.trim();

function buildDreamClusterPlanSystemPrompt(kind: "project" | "feedback"): string {
  const kindLabel = kind === "project" ? "Project" : "Feedback";
  const categoryDescription =
    kind === "project"
      ? "Project memory files capture durable project facts such as project definition, scope, goals, blockers, risks, and important progress."
      : "Feedback memory files capture durable collaboration rules, delivery rules, style rules, title/body template rules, and confirmed output constraints.";
  return `
You are the ${kindLabel} Dream cluster planner for a file-memory system.

Your job is to inspect lightweight header information only and decide which files should be refined together.

Rules:
- Use only the supplied header metadata as evidence.
- Do not assume full file contents beyond what the header says.
- ${categoryDescription}
- Return mutually exclusive candidate clusters only.
- A file may appear in at most one cluster.
- Only create a cluster when at least two files likely overlap, conflict, or should be merged into one cleaner memory file.
- If files are distinct and should remain separate, leave them out of clusters.
- Files belonging to the same current project is not, by itself, a merge reason.
- Shared workspace, shared project membership, shared domain, or shared topic is not enough unless the headers show concrete semantic overlap, fact conflict, rule duplication, or obvious consolidation value.
- Each cluster reason must name the specific overlap, conflict, repeated rule, repeated fact, or consolidation topic that justifies refinement.
- Keep reasons concise and specific.
- Natural-language output should follow the dominant language already visible in the supplied headers.
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short planning summary",
  "clusters": [
    {
      "member_relative_paths": ["Project/a.md", "Project/b.md"],
      "reason": "why these files should be refined together"
    }
  ]
}
`.trim();
}

function buildDreamClusterRefineSystemPrompt(kind: "project" | "feedback"): string {
  const kindLabel = kind === "project" ? "Project" : "Feedback";
  const categoryInstruction =
    kind === "project"
      ? [
          "Produce exactly one project memory file.",
          "Keep durable project facts only: what the project is, stable scope, goals, important progress, blockers, risks, and important decisions.",
          "Do not reduce the file to a vague status line.",
          "Prefer readable markdown headings such as ## Summary, ## Current Stage, ## Constraints, ## Blockers, ## Next Steps, ## Timeline, ## Notes when useful.",
        ].join("\n- ")
      : [
          "Produce exactly one feedback memory file.",
          "Keep durable collaboration rules only: delivery order, output structure, style constraints, title/body template guidance, and confirmed review preferences.",
          "Prefer readable markdown headings such as ## Rule, ## Why, ## How To Apply, ## Notes when useful.",
        ].join("\n- ");
  return `
You are the ${kindLabel} Dream refine engine for a file-memory system.

Your job is to merge one cluster of existing memory files into exactly one cleaner memory file.

Rules:
- Use only the supplied full file contents as evidence.
- Resolve overlap, deduplicate repeated details, and keep the most useful durable facts.
- Do not invent new facts.
- Output exactly one refined file.
- The visible output language must follow the dominant language already present in the supplied files. If the supplied files are mixed, prefer the dominant language of the cluster.
- Apply this language rule consistently to the title/name, description, markdown headings, and markdown body text.
- ${categoryInstruction}
- Return valid JSON only.

Use this exact JSON shape:
{
  "summary": "short refine summary",
  "name": "refined file title",
  "description": "one-line description",
  "markdown": "full markdown body"
}
`.trim();
}

const DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT = `
You are the Dream project metadata reviewer for a file-memory system.

Your job is to decide whether the current project metadata is clearly incorrect or outdated after project/feedback refinement.

Rules:
- Use only the supplied current metadata and the recent project/feedback files as evidence.
- Be conservative. Keep the current metadata unless the supplied evidence clearly supports a change.
- You may update only:
  - project_name
  - description
  - status
- Do not rewrite metadata just to paraphrase it.
- Natural-language output fields must follow the dominant language already present in the supplied project/feedback files.
- Return valid JSON only.

Use this exact JSON shape:
{
  "should_update": false,
  "reason": "why metadata should or should not change",
  "project_name": "final project name",
  "description": "final description",
  "status": "in_progress"
}
`.trim();

function buildUserProfileRewritePrompt(input: {
  existingProfile: MemoryUserSummary | null;
  candidates: MemoryCandidate[];
}): string {
  return JSON.stringify(
    {
      existing_profile_markdown: input.existingProfile?.files[0]?.content
        ? truncate(input.existingProfile.files[0].content, 3_200)
        : null,
      incoming_user_notes: input.candidates.map(candidate => {
        const noteMarkdown = candidate.body || candidate.profile || candidate.summary || candidate.description;
        return {
          description: truncateForPrompt(candidate.description, 180),
          note_markdown: truncate(String(noteMarkdown || ""), 1_400),
          captured_at: candidate.capturedAt ?? "",
          source_session_key: candidate.sourceSessionKey ?? "",
        };
      }),
    },
    null,
    2,
  );
}

function renderIdentityBackgroundMarkdownFromItems(items: string[]): string {
  const normalized = uniqueStrings(
    items.map(item => stripMarkdownSyntax(item)),
    20,
  );
  return normalized.map(item => `- ${item}`).join("\n");
}

function normalizeIdentityBackgroundSectionMarkdown(value: unknown): string {
  if (typeof value !== "string") {
    if (Array.isArray(value)) {
      return renderIdentityBackgroundMarkdownFromItems(
        value.filter((item): item is string => typeof item === "string"),
      ).trim();
    }
    return "";
  }

  let normalized = value
    .replace(/\r/g, "\n")
    .replace(/^```(?:markdown)?\s*/i, "")
    .replace(/```$/i, "")
    .trim();

  normalized = normalized.replace(/^#{1,6}\s*身份背景\s*\n+/i, "").trim();
  return normalized;
}

function buildUserProfileBodyFromSectionMarkdown(sectionMarkdown: unknown): string | null {
  const normalizedSection = normalizeIdentityBackgroundSectionMarkdown(sectionMarkdown);
  if (!normalizedSection) return null;
  return `## 身份背景\n${normalizedSection.trim()}\n`;
}

function extractIdentityBackgroundFactsFromProfileBody(body: string): string[] {
  return splitProfileFacts(stripMarkdownSyntax(body));
}

function buildRewrittenUserProfileCandidate(input: {
  sectionMarkdown: unknown;
  latestCandidate?: MemoryCandidate;
}): MemoryCandidate | null {
  const body = buildUserProfileBodyFromSectionMarkdown(input.sectionMarkdown);
  if (!body) return null;

  const facts = extractIdentityBackgroundFactsFromProfileBody(body);
  return {
    type: "user",
    scope: "global",
    name: "user-profile",
    description: truncateForPrompt(facts[0] || "User profile", 120),
    ...(input.latestCandidate?.capturedAt ? { capturedAt: input.latestCandidate.capturedAt } : {}),
    ...(input.latestCandidate?.sourceSessionKey ? { sourceSessionKey: input.latestCandidate.sourceSessionKey } : {}),
    body,
    ...(facts.length > 0 ? { profile: facts.join("；") } : {}),
    ...(facts.length > 0 ? { relationships: facts } : {}),
  };
}

function buildConversationTurns(messages: MemoryMessage[]): MemoryMessage[][] {
  const turns: MemoryMessage[][] = [];
  let current: MemoryMessage[] = [];
  for (const message of messages.filter(item => item.role === "user" || item.role === "assistant")) {
    if (message.role === "user") {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    if (current.length > 0) current.push(message);
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

function findFocusTurnIndex(turns: MemoryMessage[][], focusMessage: MemoryMessage): number {
  const byReference = turns.findIndex(turn => turn.some(message => message === focusMessage));
  if (byReference >= 0) return byReference;
  const byValue = turns.findIndex(turn =>
    turn.some(message => message.role === focusMessage.role && message.content === focusMessage.content),
  );
  return byValue;
}

function serializeTurnsForPrompt(
  turns: MemoryMessage[][],
): Array<{ turn_index: number; messages: Array<{ role: string; content: string }> }> {
  return turns.map((turn, index) => ({
    turn_index: index + 1,
    messages: turn.map(message => ({
      role: message.role,
      content: truncateForPrompt(message.content, 320),
    })),
  }));
}

function buildIndexPromptWindow(input: {
  batchContextMessages: MemoryMessage[];
  focusUserTurn: MemoryMessage;
  currentProjectMeta?: ProjectMetaRecord | null;
}): string {
  const turns = buildConversationTurns(input.batchContextMessages);
  const focusTurnIndex = findFocusTurnIndex(turns, input.focusUserTurn);
  const focusTurn = focusTurnIndex >= 0 ? turns[focusTurnIndex]! : [input.focusUserTurn];
  const previousTurns = focusTurnIndex >= 0 ? turns.slice(Math.max(0, focusTurnIndex - 2), focusTurnIndex) : [];
  const nextTurns = focusTurnIndex >= 0 ? turns.slice(focusTurnIndex + 1, focusTurnIndex + 3) : [];
  return JSON.stringify(
    {
      current_project_meta: input.currentProjectMeta
        ? {
            project_id: input.currentProjectMeta.projectId,
            project_name: input.currentProjectMeta.projectName,
            description: truncateForPrompt(input.currentProjectMeta.description, 220),
            status: input.currentProjectMeta.status,
            updated_at: input.currentProjectMeta.updatedAt,
          }
        : null,
      focus_user_turn: {
        role: input.focusUserTurn.role,
        content: truncateForPrompt(input.focusUserTurn.content, 400),
      },
      focus_turn_with_neighbor_assistant_context: serializeTurnsForPrompt([focusTurn])[0],
      previous_turns: serializeTurnsForPrompt(previousTurns),
      next_turns: serializeTurnsForPrompt(nextTurns),
    },
    null,
    2,
  );
}

function buildDreamFileGlobalPlanPrompt(input: LlmDreamFileGlobalPlanInput): string {
  const currentProjectNames = Array.from(
    new Set(input.currentProjects.map(project => normalizeWhitespace(project.projectName)).filter(Boolean)),
  );
  const observedMemoryLabels = Array.from(
    new Set(
      input.records
        .filter(record => record.type === "project")
        .map(record => normalizeWhitespace(record.name))
        .filter(Boolean),
    ),
  );
  return JSON.stringify(
    {
      governance_scope: {
        mode: "dream_file_global_plan",
        workspace_mode: "current_project",
        primary_truth: "existing_file_memories_only",
        writable_targets: ["project.meta.md", "Project/*.md", "Feedback/*.md"],
        forbidden_outputs: ["new project-level summary file", "new summary layer"],
      },
      merge_constraints: {
        current_project_names: currentProjectNames,
        observed_memory_labels: observedMemoryLabels,
        keep_multiple_memory_files_within_current_project: true,
        do_not_create_additional_top_level_projects: true,
      },
      current_projects: input.currentProjects.map(project => ({
        project_id: project.projectId,
        project_name: project.projectName,
        description: truncateForPrompt(project.description, 220),
        status: project.status,
        updated_at: project.updatedAt,
        dream_updated_at: project.dreamUpdatedAt ?? "",
      })),
      records: input.records.map(record => ({
        entry_id: record.entryId,
        relative_path: record.relativePath,
        type: record.type,
        scope: record.scope,
        project_id: record.projectId ?? "",
        is_tmp: record.isTmp,
        name: record.name,
        description: truncateForPrompt(record.description, 220),
        updated_at: record.updatedAt,
        captured_at: record.capturedAt ?? "",
        source_session_key: record.sourceSessionKey ?? "",
        content: truncateForPrompt(record.content, 1200),
        project: record.project
          ? {
              stage: truncateForPrompt(record.project.stage, 220),
              decisions: record.project.decisions.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              constraints: record.project.constraints.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              next_steps: record.project.nextSteps.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              blockers: record.project.blockers.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              timeline: record.project.timeline.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              notes: record.project.notes.map(item => truncateForPrompt(item, 140)).slice(0, 12),
            }
          : undefined,
        feedback: record.feedback
          ? {
              rule: truncateForPrompt(record.feedback.rule, 220),
              why: truncateForPrompt(record.feedback.why, 220),
              how_to_apply: truncateForPrompt(record.feedback.howToApply, 220),
              notes: record.feedback.notes.map(item => truncateForPrompt(item, 140)).slice(0, 12),
            }
          : undefined,
      })),
    },
    null,
    2,
  );
}

function buildDreamFileProjectRewritePrompt(input: LlmDreamFileProjectRewriteInput): string {
  return JSON.stringify(
    {
      governance_scope: {
        mode: "dream_file_project_rewrite",
        primary_truth: "supplied_project_and_feedback_files",
        forbidden_outputs: ["new project-level summary file", "new summary layer"],
        final_project_id: input.project.projectId,
      },
      project: {
        project_id: input.project.projectId,
        plan_key: input.project.planKey,
        project_name: input.project.projectName,
        description: truncateForPrompt(input.project.description, 220),
        status: input.project.status,
        merge_reason: input.project.mergeReason ?? "",
        evidence_entry_ids: input.project.evidenceEntryIds,
        retained_entry_ids: input.project.retainedEntryIds,
      },
      current_meta: input.currentMeta
        ? {
            project_id: input.currentMeta.projectId,
            project_name: input.currentMeta.projectName,
            description: truncateForPrompt(input.currentMeta.description, 220),
            status: input.currentMeta.status,
            updated_at: input.currentMeta.updatedAt,
          }
        : null,
      records: input.records.map(record => ({
        entry_id: record.entryId,
        relative_path: record.relativePath,
        type: record.type,
        is_tmp: record.isTmp,
        name: record.name,
        description: truncateForPrompt(record.description, 220),
        content: truncateForPrompt(record.content, 1200),
        project: record.project
          ? {
              stage: truncateForPrompt(record.project.stage, 220),
              decisions: record.project.decisions.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              constraints: record.project.constraints.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              next_steps: record.project.nextSteps.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              blockers: record.project.blockers.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              timeline: record.project.timeline.map(item => truncateForPrompt(item, 140)).slice(0, 12),
              notes: record.project.notes.map(item => truncateForPrompt(item, 140)).slice(0, 12),
            }
          : undefined,
        feedback: record.feedback
          ? {
              rule: truncateForPrompt(record.feedback.rule, 220),
              why: truncateForPrompt(record.feedback.why, 220),
              how_to_apply: truncateForPrompt(record.feedback.howToApply, 220),
              notes: record.feedback.notes.map(item => truncateForPrompt(item, 140)).slice(0, 12),
            }
          : undefined,
      })),
    },
    null,
    2,
  );
}

function buildDreamClusterPlanPrompt(input: LlmDreamClusterPlanInput): string {
  return JSON.stringify(
    {
      category: input.kind,
      headers: input.headers.map(header => ({
        relative_path: header.relativePath,
        name: truncateForPrompt(header.name, 120),
        description: truncateForPrompt(header.description, 220),
        updated_at: header.updatedAt,
      })),
    },
    null,
    2,
  );
}

function buildDreamClusterRefinePrompt(input: LlmDreamClusterRefineInput): string {
  return JSON.stringify(
    {
      category: input.kind,
      records: input.records.map(record => ({
        entry_id: record.entryId,
        relative_path: record.relativePath,
        type: record.type,
        name: record.name,
        description: truncateForPrompt(record.description, 220),
        updated_at: record.updatedAt,
        captured_at: record.capturedAt ?? "",
        source_session_key: record.sourceSessionKey ?? "",
        content: record.content,
      })),
    },
    null,
    2,
  );
}

function buildDreamProjectMetaReviewPrompt(input: LlmDreamProjectMetaReviewInput): string {
  return JSON.stringify(
    {
      current_project_meta: {
        project_id: input.currentMeta.projectId,
        project_name: input.currentMeta.projectName,
        description: truncateForPrompt(input.currentMeta.description, 220),
        status: input.currentMeta.status,
        updated_at: input.currentMeta.updatedAt,
        dream_updated_at: input.currentMeta.dreamUpdatedAt ?? "",
      },
      recent_project_files: input.recentProjectRecords.map(record => ({
        relative_path: record.relativePath,
        name: record.name,
        description: truncateForPrompt(record.description, 220),
        updated_at: record.updatedAt,
        content: record.content,
      })),
      recent_feedback_files: input.recentFeedbackRecords.map(record => ({
        relative_path: record.relativePath,
        name: record.name,
        description: truncateForPrompt(record.description, 220),
        updated_at: record.updatedAt,
        content: record.content,
      })),
    },
    null,
    2,
  );
}

function buildGeneralProjectMetaMergePrompt(input: LlmGeneralProjectMetaMergeInput): string {
  return JSON.stringify(
    {
      governance_scope: {
        mode: "general_project_meta_merge_plan",
        primary_truth: "supplied_general_project_meta_only",
        writable_targets: ["GeneralProjects/*.md"],
        forbidden_outputs: [
          "new project meta",
          "project memory rewrite",
          "feedback memory rewrite",
          "user profile rewrite",
        ],
      },
      project_metas: input.projectMetas.map(project => ({
        project_id: project.projectId,
        project_name: project.projectName,
        description: truncateForPrompt(project.description, 260),
        status: project.status,
        updated_at: project.updatedAt,
        dream_updated_at: project.dreamUpdatedAt ?? "",
        source_kind: project.sourceKind ?? "",
        source_workspace_path: project.sourceWorkspacePath ?? "",
        source_project_id: project.sourceProjectId ?? "",
      })),
    },
    null,
    2,
  );
}

export function buildSelectRecallProjectPrompt(input: {
  query: string;
  recentUserMessages?: MemoryMessage[];
  shortlist: ProjectShortlistCandidate[];
  allowEmpty: boolean;
}): { systemPrompt: string; userPrompt: string } {
  const { query, recentUserMessages, shortlist, allowEmpty } = input;
  const systemPrompt = [
    allowEmpty
      ? "You choose the most relevant existing formal project for long-term memory recall only when one clearly matches the current query."
      : "You choose the single most relevant formal project for long-term memory recall.",
    "Return JSON only with selected_project_id and reason.",
    allowEmpty
      ? "Select at most one project from the provided shortlist."
      : "You must select exactly one project from the provided shortlist.",
    "Use the current query first, then recent user messages only for continuation/disambiguation.",
    "Do not infer a project from assistant wording.",
    "Similar project names are distinct by default; shared domain, shared workflow, or shared feedback do not make them the same project.",
    "If the query explicitly names one shortlist project, prefer that exact project instead of broadening to a nearby or umbrella project.",
    allowEmpty
      ? "If the current query introduces or switches to a new project that is not represented in the shortlist, return an empty selected_project_id."
      : "If the current query introduces or switches to a new project, still choose the best shortlist project.",
    allowEmpty
      ? "If no shortlist project is clearly relevant, return an empty selected_project_id."
      : "If multiple shortlist projects remain plausible, still choose the best one.",
    allowEmpty
      ? "If multiple shortlist projects are plausible but evidence is not decisive, return an empty selected_project_id."
      : "When multiple shortlist projects are plausible, never return empty; choose the best match.",
    "When relevance is comparable, prefer general_local over workspace_external.",
    allowEmpty
      ? "Use empty selected_project_id to skip project-scoped recall for a new or unrelated project; do not force unrelated memory into an existing project."
      : "Never return an empty selected_project_id when the shortlist is non-empty.",
  ].join("\n");
  const userPrompt = JSON.stringify(
    {
      query,
      recent_user_messages: (recentUserMessages ?? [])
        .slice(-4)
        .map(message => truncateForPrompt(message.content, 220)),
      shortlist: shortlist.map(project => ({
        project_id: project.projectId,
        project_name: project.projectName,
        description: truncateForPrompt(project.description, 180),
        status: project.status,
        source_type: project.sourceType ?? "unknown",
        updated_at: project.updatedAt,
        shortlist_score: project.score,
        shortlist_exact: project.exact,
        shortlist_source: project.source,
        matched_text: truncateForPrompt(project.matchedText, 180),
      })),
    },
    null,
    2,
  );
  return { systemPrompt, userPrompt };
}

export function buildSelectIndexProjectPrompt(input: {
  candidate: MemoryCandidate;
  candidatePreview: string;
  focusTurn: MemoryMessage;
  recentUserMessages?: MemoryMessage[];
  shortlist: ProjectShortlistCandidate[];
}): { systemPrompt: string; userPrompt: string } {
  const { candidate, candidatePreview, focusTurn, recentUserMessages, shortlist } = input;
  const systemPrompt = [
    "You assign a newly generated long-term memory item to a General Chat project.",
    "This is index-time memory assignment, not recall.",
    "Return JSON only with decision, selected_project_id, and reason.",
    "decision must be one of: attach_existing, create_new.",
    "The primary evidence is candidate_memory_preview: the memory item that will be written.",
    "Use the focus user turn and recent user messages only as supporting context for disambiguation.",
    "Choose attach_existing only when the candidate clearly belongs to exactly one existing General project.",
    "Choose create_new when the candidate is a new project, evidence is insufficient, multiple projects remain plausible, or the match is only a broad domain similarity.",
    "Do not attach just because projects share a category such as SaaS, copywriting, Xiaohongshu, marketing, planning, or content creation.",
    "All shortlist projects are General-local assignment targets; never infer or write to an external workspace.",
    "If decision is attach_existing, selected_project_id must be one id from the shortlist.",
    "If decision is create_new, selected_project_id must be an empty string.",
  ].join("\n");
  const userPrompt = JSON.stringify(
    {
      candidate: {
        type: candidate.type,
        name: truncateForPrompt(candidate.name, 120),
        description: truncateForPrompt(candidate.description, 220),
        rule: candidate.rule ? truncateForPrompt(candidate.rule, 220) : null,
        summary: candidate.summary ? truncateForPrompt(candidate.summary, 220) : null,
        why: candidate.why ? truncateForPrompt(candidate.why, 220) : null,
        how_to_apply: candidate.howToApply ? truncateForPrompt(candidate.howToApply, 220) : null,
        stage: candidate.stage ? truncateForPrompt(candidate.stage, 220) : null,
        decisions: (candidate.decisions ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
        constraints: (candidate.constraints ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
        next_steps: (candidate.nextSteps ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
        blockers: (candidate.blockers ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
        timeline: (candidate.timeline ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
        notes: (candidate.notes ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
      },
      candidate_memory_preview: truncateForPrompt(candidatePreview, 1600),
      focus_user_turn: truncateForPrompt(focusTurn.content, 360),
      recent_user_messages: (recentUserMessages ?? [])
        .slice(-4)
        .map(message => truncateForPrompt(message.content, 220)),
      shortlist: shortlist.map(project => ({
        project_id: project.projectId,
        project_name: project.projectName,
        description: truncateForPrompt(project.description, 180),
        status: project.status,
        updated_at: project.updatedAt,
        shortlist_score: project.score,
        shortlist_exact: project.exact,
        shortlist_source: project.source,
        matched_text: truncateForPrompt(project.matchedText, 180),
      })),
    },
    null,
    2,
  );
  return { systemPrompt, userPrompt };
}

export function buildExtractionUserPrompt(input: {
  timestamp: string;
  knownProjects: ProjectIdentityHint[];
  batchContextMessages: MemoryMessage[];
  focusMessages: MemoryMessage[];
}): string {
  const { timestamp, knownProjects, batchContextMessages, focusMessages } = input;
  return JSON.stringify(
    {
      timestamp,
      known_projects: knownProjects.slice(0, 20).map(project => ({
        identity_key: project.identityKey,
        project_id: project.projectId ?? "",
        project_name: project.projectName,
        description: truncateForPrompt(project.description, 180),
        scope: project.scope,
        updated_at: project.updatedAt,
      })),
      batch_context: batchContextMessages.map(message => ({
        role: message.role,
        content: truncateForPrompt(message.content, 260),
      })),
      focus_user_turn: focusMessages.map(message => ({
        role: message.role,
        content: truncateForPrompt(message.content, 320),
      })),
    },
    null,
    2,
  );
}

export {
  DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS,
  DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS,
  DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS,
  DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS,
  DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS,
  DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
  DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS,
  DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
  DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS,
  DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS,
  DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS,
  DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT,
  DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT,
  DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT,
  FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT,
  GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT,
  MEMORY_CLASSIFICATION_SYSTEM_PROMPT,
  PROJECT_NOTE_CREATE_SYSTEM_PROMPT,
  USER_NOTE_CREATE_SYSTEM_PROMPT,
  USER_PROFILE_REWRITE_SYSTEM_PROMPT,
  buildConversationTurns,
  buildDreamClusterPlanPrompt,
  buildDreamClusterPlanSystemPrompt,
  buildDreamClusterRefinePrompt,
  buildDreamClusterRefineSystemPrompt,
  buildDreamFileGlobalPlanPrompt,
  buildDreamFileProjectRewritePrompt,
  buildDreamProjectMetaReviewPrompt,
  buildGeneralProjectMetaMergePrompt,
  buildIndexPromptWindow,
  buildRewrittenUserProfileCandidate,
  buildUserProfileBodyFromSectionMarkdown,
  buildUserProfileRewritePrompt,
  extractIdentityBackgroundFactsFromProfileBody,
  findFocusTurnIndex,
  normalizeIdentityBackgroundSectionMarkdown,
  renderIdentityBackgroundMarkdownFromItems,
  serializeTurnsForPrompt,
};
