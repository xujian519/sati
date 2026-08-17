// llm-extraction 的抽取候选归一化（从 extractFileMemoryCandidates 拆出，行为等价）。
// 纯函数：信号提取 / 单条候选归一 / 边界过滤，discarded 经返回值传出（无副作用）。
// 依赖 hints（G7）与 normalizers（G6），hints/normalizers 不依赖本文件，无环。
import {
  normalizeStringArray,
  normalizeWhitespace,
  truncateForPrompt,
  uniqueStrings,
  isRecord,
} from "./llm-normalizers.js";
import {
  deriveFeedbackCandidateName,
  extractProjectDescriptorHint,
  extractProjectNameFromContent,
  extractProjectNameHint,
  extractProjectStageHint,
  extractSingleHint,
  extractTimelineHints,
  extractUniqueBatchProjectName,
  hasGenericProjectAnchor,
  isGenericProjectCandidateName,
  isLikelyHumanReadableProjectIdentifier,
  isStableFormalProjectId,
  looksLikeCollaborationRuleText,
  looksLikeConcreteProjectMemoryText,
  looksLikeProjectFollowUpText,
  looksLikeProjectRiskText,
  looksLikeProjectScopeText,
  sanitizeFeedbackSectionText,
  sanitizeProjectDescriptionText,
  selectKnownProjectHint,
  stripExplicitRememberLead,
} from "./llm-hints.js";
import type { FileMemoryExtractionDiscardedCandidate } from "./llm-extraction.js";
import type { MemoryCandidate, MemoryMessage, ProjectIdentityHint, ProjectShortlistCandidate } from "../types.js";

// 抽取系统提示词（extractFileMemoryCandidates 的内联提示词提取为常量）。
export const EXTRACTION_SYSTEM_PROMPT_LINES = [
  "You extract long-term memory candidates for one focus conversation turn using recent session context since the last indexing cursor.",
  "Return JSON only with an items array.",
  "Allowed item.type values: user, feedback, project.",
  "Discard anything that is too transient or not useful across future sessions.",
  "Use the batch context to interpret ambiguous references in the focus turn, but only emit memories justified by the focus user turn itself.",
  "known_projects contains the durable identity of the current workspace project.",
  "The assistant replies in the batch context are supporting context only. Never create a memory candidate from assistant wording alone.",
  "For user items only keep stable personal identity/background facts or durable relationships. Never place project state, collaboration rules, reply preferences, language choices, style rules, or file boundaries inside user memory.",
  "If a first-person statement is really about how the assistant should collaborate, write, format, reply, or operate on files, it is feedback, not user.",
  "Global-seeming reply preferences and personal file boundaries still belong to feedback in this runtime. Examples: '默认使用中文输出', '如果有结论先给结论再给细节', '不要改动我的 .gitignore 文件', '我更关心项目进度、风险和上线阻塞点'.",
  "If the focus turn tells the assistant how to collaborate, deliver, report, format, or structure outputs, that is feedback, not project.",
  "If the focus turn says how outputs should be delivered, such as title count, body order, cover copy, progress update order, or reply structure, you must classify it as feedback rather than project.",
  "For feedback items always provide rule, why, and how_to_apply.",
  "For feedback items: why means why the user gave this feedback, usually a past incident, strong preference, or explicit dissatisfaction. Do not invent a reason if the transcript does not contain one.",
  "For feedback items: how_to_apply means when or where this guidance should be applied, such as during progress updates, reviews, or project replies. Do not restate the rule verbatim if the application context is unclear.",
  "If the transcript gives a rule but not enough evidence for why or how_to_apply, return an empty string for those fields.",
  "Feedback belongs to the current project workflow; if project_id is unclear you may omit it because the runtime already knows the current project.",
  "If the batch context contains the current project identity, you may attach project_id to the feedback item; leaving it empty is also acceptable in current-project mode.",
  "If the focus user turn explicitly asks the assistant to remember something long-term, such as '请记住', '帮我记住', or 'remember this', treat that as a stronger signal that durable memory should be extracted.",
  "That stronger signal is still based on the raw user text itself. Do not rely on any hidden remember flag or external rule; decide only from the visible transcript content.",
  "For project items always prefer name plus description. project_id is optional and only refers to the current project identity when supplied.",
  "If you only know the project's human-readable title, put it in name and leave project_id empty.",
  "Do not put a human-readable project title only inside project_id.",
  "For project items provide stage, decisions, constraints, next_steps, blockers, and absolute-date timeline entries when dates are mentioned. You may omit project_id when the project identity is still unclear.",
  "A project-definition turn is about project name, what the project is, its stage, goals, blockers, milestones, or timeline. A delivery rule alone is never a project item.",
  "Treat explicit project-definition statements as project memory even without a remember command. Examples: '这个项目先叫 Boreal', '它是一个本地知识库整理工具', '目前还在设计阶段'.",
  "Natural follow-up turns can still be project memory even when they do not repeat the project name.",
  "If the batch context already contains the current project identity, and the focus turn says things like '这个项目接下来最该补的是...', '这个方向还差...', '先把镜头顺序模板化', or mentions stage, priorities, blockers, constraints, target audience, or content angle, emit a project item for that current project.",
  "If known_projects contains the current project identity and the focus turn states current scope, retained tools, risks, blockers, or project follow-up facts without repeating the project name, attach the memory to that current project instead of inventing a new top-level project.",
  "Do not require the focus turn to repeat the project name when the batch context already makes the project identity unique.",
  "Treat explicit collaboration instructions as feedback. Example: '在这个项目里，每次给我交付时都先给3个标题，再给正文，再给封面文案.'",
  "When a transcript names a project, describes what the project is, or states its current stage, emit a project item unless the content is obviously too transient.",
  "Do not create placeholder project names like overview, project, or memory-item.",
  "Generic anchors such as '这个项目' only become project memory when the batch context provides a unique project identity.",
  'If no durable memory should be saved, return {"items":[]}.',
];

export interface ExtractionFocusSignals {
  focusMessages: MemoryMessage[];
  focusText: string;
  explicitProjectName: string;
  explicitProjectDescriptor: string;
  explicitProjectStage: string;
  explicitTimeline: string[];
  explicitGoal: string;
  explicitBlocker: string;
  genericProjectAnchor: boolean;
  uniqueBatchProjectName: string;
  selectedKnownProject: ProjectIdentityHint | undefined;
  contextProjectName: string;
  projectFollowUpSignal: boolean;
  projectRiskSignal: boolean;
  projectScopeSignal: boolean;
  projectDefinitionSignal: boolean;
  feedbackInstructionSignal: boolean;
}

export function extractFocusSignals(input: {
  messages: MemoryMessage[];
  batchContextMessages: MemoryMessage[];
  knownProjects: ProjectIdentityHint[];
}): ExtractionFocusSignals {
  const focusMessages = input.messages.filter(message => message.role === "user");
  const focusText = focusMessages
    .filter(message => message.role === "user")
    .map(message => message.content)
    .join("\n");
  const explicitProjectName = extractProjectNameHint(focusText);
  const explicitProjectDescriptor = extractProjectDescriptorHint(focusText);
  const explicitProjectStage = extractProjectStageHint(focusText);
  const explicitTimeline = extractTimelineHints(focusText);
  const explicitGoal = extractSingleHint(focusText, /目标(?:是|为|:|：)?\s*([^。；;\n]+)/i);
  const explicitBlocker = extractSingleHint(focusText, /当前卡点(?:是|为)?([^。；;\n]+)/i);
  const genericProjectAnchor = hasGenericProjectAnchor(focusText);
  const uniqueBatchProjectName = extractUniqueBatchProjectName(input.batchContextMessages);
  const selectedKnownProject = selectKnownProjectHint(focusText, input.knownProjects);
  const contextProjectName = selectedKnownProject?.projectName ?? uniqueBatchProjectName;
  const projectFollowUpSignal = looksLikeProjectFollowUpText(focusText);
  const projectRiskSignal = looksLikeProjectRiskText(focusText);
  const projectScopeSignal = looksLikeProjectScopeText(focusText);
  const projectDefinitionSignal = Boolean(
    explicitProjectName ||
      explicitProjectDescriptor ||
      explicitProjectStage ||
      explicitGoal ||
      explicitBlocker ||
      explicitTimeline.length > 0 ||
      projectRiskSignal ||
      projectScopeSignal ||
      looksLikeConcreteProjectMemoryText(focusText),
  );
  const feedbackInstructionSignal = looksLikeCollaborationRuleText(focusText);
  return {
    focusMessages,
    focusText,
    explicitProjectName,
    explicitProjectDescriptor,
    explicitProjectStage,
    explicitTimeline,
    explicitGoal,
    explicitBlocker,
    genericProjectAnchor,
    uniqueBatchProjectName,
    selectedKnownProject,
    contextProjectName,
    projectFollowUpSignal,
    projectRiskSignal,
    projectScopeSignal,
    projectDefinitionSignal,
    feedbackInstructionSignal,
  };
}

export function normalizeExtractionItem(input: {
  item: Record<string, unknown>;
  signals: ExtractionFocusSignals;
  sessionKey?: string;
  timestamp: string;
}): { candidate: MemoryCandidate | null; discarded?: FileMemoryExtractionDiscardedCandidate } {
  const { item, signals, sessionKey, timestamp } = input;
  const type = item.type === "feedback" || item.type === "project" ? item.type : item.type === "user" ? "user" : null;
  if (!type) {
    return {
      candidate: null,
      discarded: {
        reason: "invalid_schema",
        summary: typeof item.type === "string" ? `Unsupported type: ${item.type}` : "Missing candidate type.",
      },
    };
  }
  const rawName = typeof item.name === "string" ? truncateForPrompt(item.name, 80) : "";
  const rawProjectName = typeof item.project_name === "string" ? truncateForPrompt(item.project_name, 80) : "";
  const rawProjectId = typeof item.project_id === "string" ? truncateForPrompt(item.project_id, 80) : "";
  const rawContent = typeof item.content === "string" ? truncateForPrompt(normalizeWhitespace(item.content), 280) : "";
  const feedbackRule = typeof item.rule === "string" ? truncateForPrompt(normalizeWhitespace(item.rule), 220) : "";
  const rawDescription = typeof item.description === "string" ? truncateForPrompt(item.description, 180) : "";
  const rawSummary = typeof item.summary === "string" ? truncateForPrompt(item.summary, 180) : "";
  const rawStage = typeof item.stage === "string" ? truncateForPrompt(item.stage, 220) : "";
  const rawGoal = typeof item.goal === "string" ? truncateForPrompt(normalizeWhitespace(item.goal), 180) : "";
  const rawDecisions = normalizeStringArray(item.decisions, 10);
  const rawConstraints = normalizeStringArray(item.constraints, 10);
  const rawNextSteps = normalizeStringArray(item.next_steps, 10);
  const rawBlockers = normalizeStringArray(item.blockers, 10);
  const timeline = normalizeStringArray(item.timeline, 10);
  const rawNotes = normalizeStringArray(item.notes, 10);
  const structuredProjectSummary = truncateForPrompt(
    rawDecisions[0] || rawConstraints[0] || rawNextSteps[0] || rawBlockers[0] || timeline[0] || rawNotes[0] || "",
    180,
  );
  if (type === "feedback" && !feedbackRule) {
    return {
      candidate: null,
      discarded: {
        reason: "invalid_schema",
        candidateType: type,
        ...(rawName || typeof item.name === "string" ? { candidateName: rawName || String(item.name).trim() } : {}),
        summary: "Feedback candidate missing a non-empty rule.",
      },
    };
  }
  const candidateType = type;
  const shouldPinToKnownProject = Boolean(signals.selectedKnownProject && !signals.explicitProjectName);
  const projectNameFallback =
    candidateType === "project"
      ? truncateForPrompt(
          signals.explicitProjectName ||
            (shouldPinToKnownProject ? (signals.selectedKnownProject?.projectName ?? "") : "") ||
            rawName ||
            rawProjectName ||
            (isLikelyHumanReadableProjectIdentifier(rawProjectId) ? rawProjectId : "") ||
            extractProjectNameFromContent(rawContent) ||
            signals.contextProjectName,
          80,
        )
      : "";
  const description =
    rawDescription ||
    (typeof item.profile === "string"
      ? truncateForPrompt(item.profile, 180)
      : rawContent
        ? sanitizeProjectDescriptionText(rawContent, projectNameFallback)
        : rawSummary
          ? rawSummary
          : feedbackRule
            ? truncateForPrompt(feedbackRule, 180)
            : rawGoal
              ? rawGoal
              : signals.explicitProjectDescriptor
                ? signals.explicitProjectDescriptor
                : signals.explicitGoal
                  ? signals.explicitGoal
                  : rawStage
                    ? truncateForPrompt(rawStage, 180)
                    : signals.explicitProjectStage
                      ? truncateForPrompt(signals.explicitProjectStage, 180)
                      : structuredProjectSummary);
  const normalizedProjectDescription =
    candidateType === "project" &&
    structuredProjectSummary &&
    (!description || description === signals.explicitProjectDescriptor || description === signals.explicitGoal)
      ? structuredProjectSummary
      : description;
  const name =
    candidateType === "user"
      ? "user-profile"
      : candidateType === "feedback"
        ? truncateForPrompt(rawName || deriveFeedbackCandidateName(feedbackRule), 80)
        : projectNameFallback;
  const preferences = candidateType === "user" ? [] : normalizeStringArray(item.preferences, 10);
  const constraints = candidateType === "user" ? [] : rawConstraints;
  const decisions =
    candidateType === "project" && signals.projectScopeSignal
      ? uniqueStrings([...rawDecisions, normalizeWhitespace(stripExplicitRememberLead(signals.focusText))], 10)
      : rawDecisions;
  const nextSteps = rawNextSteps;
  const blockers =
    candidateType === "project" && signals.projectRiskSignal
      ? uniqueStrings([...rawBlockers, normalizeWhitespace(stripExplicitRememberLead(signals.focusText))], 10)
      : rawBlockers;
  const notes =
    candidateType === "project" && !signals.projectScopeSignal && !signals.projectRiskSignal
      ? rawNotes
      : uniqueStrings(rawNotes, 10);
  const relationships = normalizeStringArray(item.relationships, 10);
  const hasUserPayload = Boolean(
    normalizedProjectDescription ||
      rawContent ||
      (typeof item.profile === "string" && normalizeWhitespace(item.profile)) ||
      (typeof item.summary === "string" && normalizeWhitespace(item.summary)) ||
      relationships.length > 0,
  );
  if (candidateType === "project" && (!name || !description)) {
    return {
      candidate: null,
      discarded: {
        reason: "invalid_schema",
        candidateType,
        ...(name || rawName ? { candidateName: name || rawName } : {}),
        summary: "Candidate missing a stable name or description.",
      },
    };
  }
  if (candidateType === "user" && (!name || !hasUserPayload)) {
    return {
      candidate: null,
      discarded: {
        reason: "invalid_schema",
        candidateType,
        candidateName: "user-profile",
        summary: "User candidate did not contain any durable profile content.",
      },
    };
  }
  if (candidateType === "project" && isGenericProjectCandidateName(name)) {
    return {
      candidate: null,
      discarded: {
        reason: "generic_project_name",
        candidateType,
        candidateName: name,
        summary: description,
      },
    };
  }
  return {
    candidate: {
      type: candidateType,
      scope: candidateType === "user" ? "global" : "project",
      ...(() => {
        if (candidateType !== "project" && candidateType !== "feedback") return {};
        if (typeof item.project_id === "string" && isStableFormalProjectId(item.project_id)) {
          return { projectId: item.project_id.trim() };
        }
        if (
          signals.selectedKnownProject?.projectId &&
          isStableFormalProjectId(signals.selectedKnownProject.projectId)
        ) {
          return { projectId: signals.selectedKnownProject.projectId };
        }
        return {};
      })(),
      name,
      description: normalizedProjectDescription,
      ...(sessionKey ? { sourceSessionKey: sessionKey } : {}),
      capturedAt: timestamp,
      ...(typeof item.profile === "string"
        ? { profile: truncateForPrompt(item.profile, 280) }
        : rawContent
          ? { profile: rawContent }
          : {}),
      ...(typeof item.summary === "string" ? { summary: truncateForPrompt(item.summary, 280) } : {}),
      ...(preferences.length > 0 ? { preferences } : {}),
      ...(constraints.length > 0 ? { constraints } : {}),
      ...(relationships.length > 0 ? { relationships } : {}),
      ...(candidateType === "feedback" && feedbackRule ? { rule: feedbackRule } : {}),
      ...(typeof item.why === "string" && sanitizeFeedbackSectionText(item.why) && candidateType === "feedback"
        ? { why: truncateForPrompt(sanitizeFeedbackSectionText(item.why), 280) }
        : {}),
      ...(typeof item.how_to_apply === "string" &&
      sanitizeFeedbackSectionText(item.how_to_apply) &&
      candidateType === "feedback"
        ? { howToApply: truncateForPrompt(sanitizeFeedbackSectionText(item.how_to_apply), 280) }
        : {}),
      ...(candidateType === "project" && rawStage ? { stage: rawStage } : {}),
      decisions,
      nextSteps,
      blockers,
      timeline,
      notes,
    },
  };
}

export function filterExtractionCandidate(input: {
  item: MemoryCandidate;
  signals: ExtractionFocusSignals;
  hasStructuredProjectEvidence: boolean;
  text: string;
}): { keep: boolean; discarded?: FileMemoryExtractionDiscardedCandidate } {
  const { item, signals, hasStructuredProjectEvidence, text } = input;
  if (item.type === "user") {
    return { keep: true };
  }
  if (item.type === "project") {
    if (signals.feedbackInstructionSignal && !signals.projectDefinitionSignal) {
      return {
        keep: false,
        discarded: {
          reason: "violates_feedback_project_boundary",
          candidateType: item.type,
          candidateName: item.name,
          summary: item.description,
        },
      };
    }
    if (signals.genericProjectAnchor && !signals.projectDefinitionSignal && !signals.contextProjectName) {
      return {
        keep: false,
        discarded: {
          reason: "generic_anchor_without_unique_project",
          candidateType: item.type,
          candidateName: item.name,
          summary: item.description,
        },
      };
    }
    if (
      signals.genericProjectAnchor &&
      !signals.projectDefinitionSignal &&
      signals.contextProjectName &&
      !hasStructuredProjectEvidence &&
      !signals.projectFollowUpSignal &&
      !looksLikeConcreteProjectMemoryText(text) &&
      !looksLikeProjectFollowUpText(text)
    ) {
      return {
        keep: false,
        discarded: {
          reason: "generic_anchor_without_project_definition",
          candidateType: item.type,
          candidateName: item.name,
          summary: item.description,
        },
      };
    }
  }
  if (item.type === "feedback" && signals.projectDefinitionSignal && !signals.feedbackInstructionSignal) {
    return {
      keep: false,
      discarded: {
        reason: "violates_feedback_project_boundary",
        candidateType: item.type,
        candidateName: item.name,
        summary: item.description,
      },
    };
  }
  return { keep: true };
}

export function resolveSelectedProject(input: {
  selectedProjectId: string;
  shortlist: ProjectShortlistCandidate[];
  allowEmpty: boolean;
  fallbackProject: ProjectShortlistCandidate;
  parsedReason?: unknown;
}): { projectId?: string; reason?: string } {
  const { selectedProjectId, shortlist, allowEmpty, fallbackProject, parsedReason } = input;
  const matched = shortlist.find(project => project.projectId === selectedProjectId);
  const reason = typeof parsedReason === "string" && parsedReason.trim() ? truncateForPrompt(parsedReason, 220) : "";
  if (matched) {
    return {
      projectId: matched.projectId,
      ...(reason ? { reason } : {}),
    };
  }
  if (allowEmpty) {
    return {
      ...(reason
        ? { reason }
        : {
            reason: selectedProjectId
              ? "Model returned a project id outside the shortlist."
              : "Model returned no matching project.",
          }),
    };
  }
  return {
    projectId: fallbackProject.projectId,
    ...(reason
      ? { reason }
      : { reason: `Fallback selected ${fallbackProject.projectName}; model returned no valid project id.` }),
  };
}

export function resolveIndexAssignment(input: {
  decision: unknown;
  selectedProjectId: string;
  shortlist: ProjectShortlistCandidate[];
  parsedReason?: unknown;
}): { decision: "attach_existing" | "create_new"; projectId?: string; reason?: string } {
  const { decision: rawDecision, selectedProjectId, shortlist, parsedReason } = input;
  const decision = rawDecision === "attach_existing" ? "attach_existing" : "create_new";
  const matched = shortlist.find(project => project.projectId === selectedProjectId);
  const reason = typeof parsedReason === "string" && parsedReason.trim() ? truncateForPrompt(parsedReason, 260) : "";
  if (decision === "attach_existing" && matched) {
    return {
      decision: "attach_existing",
      projectId: matched.projectId,
      ...(reason ? { reason } : {}),
    };
  }
  return {
    decision: "create_new",
    ...(reason
      ? { reason }
      : {
          reason:
            decision === "attach_existing"
              ? "Model selected an invalid project id."
              : "Model chose to create a new General project.",
        }),
  };
}
