import type {
  MemoryCandidate,
  MemoryMessage,
  MemoryRoute,
  MemoryUserSummary,
  ProjectIdentityHint,
  ProjectMetaRecord,
  ProjectShortlistCandidate,
  RecallHeaderEntry,
  RetrievalPromptDebug,
} from "../types.js";
import { truncate as truncateBase } from "../utils/text.js";
import {
  DEFAULT_REQUEST_MAX_ATTEMPTS,
  REQUEST_RETRYABLE_STATUS_CODES,
  computeRetryDelayMs,
  isTimeoutError,
  isTransientRequestError,
  resolveRequestTimeoutMs,
  sleep,
} from "./request-retry.js";
import {
  extractFirstJsonObject,
  extractLooseJsonEnvelope,
  extractLooseJsonBooleanProperty,
  extractLooseJsonStringProperty,
  tryParseLooseMemoryCreatePayload,
  type RawMemoryCreatePayload,
} from "./llm-json.js";
import {
  chooseBestRecallProjectFallback,
  clampConfidence,
  isRecord,
  normalizeBoolean,
  normalizeDreamCluster,
  normalizeDreamFileEntryIds,
  normalizeDreamFileGlobalPlanProject,
  normalizeDreamFileMergeReason,
  normalizeDreamFileProjectId,
  normalizeDreamFileProjectMetaPayload,
  normalizeDreamFileProjectRewriteFile,
  normalizeDreamFileProjectStatus,
  normalizeDreamProjectMetaReview,
  normalizeGeneralProjectMetaMergeGroup,
  normalizeMemoryRoute,
  normalizeStringArray,
  normalizeWhitespace,
  sanitizeHeaders,
  stripTrailingSlash,
  truncate,
  truncateForPrompt,
  uniqueStrings,
} from "./llm-normalizers.js";
import {
  buildSyntheticProjectFollowUpCandidate,
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
  looksLikeProjectBlockerText,
  looksLikeProjectConstraintText,
  looksLikeProjectFollowUpText,
  looksLikeProjectNextStepText,
  looksLikeProjectRiskText,
  looksLikeProjectScopeText,
  projectIdentityTerms,
  sanitizeFeedbackSectionText,
  sanitizeProjectDescriptionText,
  selectKnownProjectHint,
  splitProfileFacts,
  stripExplicitRememberLead,
  stripMarkdownSyntax,
} from "./llm-hints.js";
import {
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
} from "./llm-prompts.js";

type LoggerLike = {
  info?: (...args: unknown[]) => void;
  warn?: (...args: unknown[]) => void;
  error?: (...args: unknown[]) => void;
};

type ProviderHeaders = Record<string, string> | undefined;
type PromptDebugSink = (debug: RetrievalPromptDebug) => void;

export interface FileMemoryExtractionDiscardedCandidate {
  reason: string;
  candidateType?: "user" | "feedback" | "project";
  candidateName?: string;
  summary?: string;
}

export interface FileMemoryExtractionDebug {
  parsedItems: unknown[];
  normalizedCandidates: MemoryCandidate[];
  discarded: FileMemoryExtractionDiscardedCandidate[];
  finalCandidates: MemoryCandidate[];
  fallbackApplied?: string;
}

interface ModelSelection {
  provider: string;
  model: string;
  api: string;
  baseUrl?: string;
  headers?: ProviderHeaders;
}

interface RawUserProfilePayload {
  identity_background_markdown?: unknown;
  identity_background?: unknown;
  /**
   * Per-note absorption decisions, one entry per incoming user note (same
   * order). Absent when the model did not report them — callers must then
   * keep all notes rather than delete unverified content.
   */
  note_absorption?: Array<{ note_index?: unknown; absorbed?: unknown }>;
}

type MemoryCreateKind = "user" | "project" | "feedback";

export interface MemoryClassificationLabel {
  type: MemoryCreateKind;
  reason: string;
  evidence: string;
}

export interface FileMemoryClassificationResult {
  shouldStore: boolean;
  labels: MemoryClassificationLabel[];
}

interface RawMemoryClassificationLabelPayload {
  type?: unknown;
  reason?: unknown;
  evidence?: unknown;
}

interface RawMemoryClassificationPayload {
  should_store?: unknown;
  labels?: unknown;
}

interface RawDreamFileGlobalPlanProjectPayload {
  plan_key?: unknown;
  target_project_id?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
  merge_reason?: unknown;
  evidence_entry_ids?: unknown;
  retained_entry_ids?: unknown;
}

interface RawDreamFileGlobalPlanPayload {
  summary?: unknown;
  duplicate_topic_count?: unknown;
  conflict_topic_count?: unknown;
  projects?: unknown;
  deleted_project_ids?: unknown;
  deleted_entry_ids?: unknown;
}

interface RawDreamFileProjectRewriteFilePayload {
  type?: unknown;
  name?: unknown;
  description?: unknown;
  source_entry_ids?: unknown;
  stage?: unknown;
  decisions?: unknown;
  constraints?: unknown;
  next_steps?: unknown;
  blockers?: unknown;
  timeline?: unknown;
  notes?: unknown;
  rule?: unknown;
  why?: unknown;
  how_to_apply?: unknown;
}

interface RawDreamFileProjectRewritePayload {
  summary?: unknown;
  project_meta?: unknown;
  files?: unknown;
  deleted_entry_ids?: unknown;
}

interface RawDreamClusterPayload {
  member_relative_paths?: unknown;
  reason?: unknown;
}

interface RawDreamClusterPlanPayload {
  summary?: unknown;
  clusters?: unknown;
}

interface RawDreamClusterRefinePayload {
  summary?: unknown;
  name?: unknown;
  description?: unknown;
  markdown?: unknown;
}

interface RawProjectMetaReviewPayload {
  should_update?: unknown;
  reason?: unknown;
  project_name?: unknown;
  description?: unknown;
  status?: unknown;
}

interface RawGeneralProjectMetaMergeGroupPayload {
  keeper_project_id?: unknown;
  duplicate_project_ids?: unknown;
  reason?: unknown;
}

interface RawGeneralProjectMetaMergePlanPayload {
  summary?: unknown;
  merge_groups?: unknown;
}

export interface LlmDreamFileProjectMetaInput {
  projectId: string;
  projectName: string;
  description: string;
  status: string;
  updatedAt: string;
  dreamUpdatedAt?: string;
  sourceKind?: string;
  sourceWorkspacePath?: string;
  sourceProjectId?: string;
}

export interface LlmDreamFileRecordInput {
  entryId: string;
  relativePath: string;
  type: "project" | "feedback";
  scope: "project";
  projectId?: string;
  isTmp: boolean;
  name: string;
  description: string;
  updatedAt: string;
  capturedAt?: string;
  sourceSessionKey?: string;
  content: string;
  project?: {
    stage: string;
    decisions: string[];
    constraints: string[];
    nextSteps: string[];
    blockers: string[];
    timeline: string[];
    notes: string[];
  };
  feedback?: {
    rule: string;
    why: string;
    howToApply: string;
    notes: string[];
  };
}

export interface LlmDreamFileGlobalPlanInput {
  currentProjects: LlmDreamFileProjectMetaInput[];
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamFileGlobalPlanProject {
  planKey: string;
  targetProjectId?: string;
  projectName: string;
  description: string;
  status: string;
  mergeReason?: "rename" | "alias_equivalence" | "duplicate_formal_project";
  evidenceEntryIds: string[];
  retainedEntryIds: string[];
}

export interface LlmDreamFileGlobalPlanOutput {
  summary: string;
  duplicateTopicCount: number;
  conflictTopicCount: number;
  projects: LlmDreamFileGlobalPlanProject[];
  deletedProjectIds: string[];
  deletedEntryIds: string[];
}

export interface LlmDreamFileProjectRewriteInput {
  project: LlmDreamFileGlobalPlanProject & { projectId: string };
  currentMeta: LlmDreamFileProjectMetaInput | null;
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamFileProjectRewriteOutputFile {
  type: "project" | "feedback";
  name: string;
  description: string;
  sourceEntryIds: string[];
  stage?: string;
  decisions?: string[];
  constraints?: string[];
  nextSteps?: string[];
  blockers?: string[];
  timeline?: string[];
  notes?: string[];
  rule?: string;
  why?: string;
  howToApply?: string;
}

export interface LlmDreamFileProjectRewriteOutput {
  summary: string;
  projectMeta: {
    projectName: string;
    description: string;
    status: string;
  };
  files: LlmDreamFileProjectRewriteOutputFile[];
  deletedEntryIds: string[];
}

export interface LlmGeneralProjectMetaMergeInput {
  projectMetas: LlmDreamFileProjectMetaInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmGeneralProjectMetaMergeGroup {
  keeperProjectId: string;
  duplicateProjectIds: string[];
  reason: string;
}

export interface LlmGeneralProjectMetaMergeOutput {
  summary: string;
  mergeGroups: LlmGeneralProjectMetaMergeGroup[];
}

export interface LlmDreamClusterHeaderInput {
  relativePath: string;
  name: string;
  description: string;
  updatedAt: string;
}

export interface LlmDreamCluster {
  memberRelativePaths: string[];
  reason: string;
}

export interface LlmDreamClusterPlanInput {
  kind: "project" | "feedback";
  headers: LlmDreamClusterHeaderInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamClusterPlanOutput {
  summary: string;
  clusters: LlmDreamCluster[];
}

export interface LlmDreamClusterRefineInput {
  kind: "project" | "feedback";
  records: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamClusterRefineOutput {
  summary: string;
  file: {
    name: string;
    description: string;
    markdown: string;
  } | null;
}

export interface LlmDreamProjectMetaReviewInput {
  currentMeta: LlmDreamFileProjectMetaInput;
  recentProjectRecords: LlmDreamFileRecordInput[];
  recentFeedbackRecords: LlmDreamFileRecordInput[];
  agentId?: string;
  timeoutMs?: number;
  debugTrace?: PromptDebugSink;
}

export interface LlmDreamProjectMetaReviewOutput {
  shouldUpdate: boolean;
  reason: string;
  projectMeta: {
    projectName: string;
    description: string;
    status: string;
  };
}

function parseModelRef(
  modelRef: string | undefined,
  config: Record<string, unknown>,
): { provider: string; model: string } | undefined {
  if (typeof modelRef === "string" && modelRef.includes("/")) {
    const [provider, ...rest] = modelRef.split("/");
    const model = rest.join("/").trim();
    if (provider?.trim() && model) {
      return { provider: provider.trim(), model };
    }
  }

  const modelsConfig = isRecord(config.models) ? config.models : undefined;
  const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
  if (!providers) return undefined;

  if (typeof modelRef === "string" && modelRef.trim()) {
    const providerEntries = Object.entries(providers);
    if (providerEntries.length === 1) {
      return { provider: providerEntries[0]![0], model: modelRef.trim() };
    }
  }

  for (const [provider, providerConfig] of Object.entries(providers)) {
    if (!isRecord(providerConfig)) continue;
    const models = Array.isArray(providerConfig.models) ? providerConfig.models : [];
    const firstModel = models.find(entry => isRecord(entry) && typeof entry.id === "string" && entry.id.trim());
    if (firstModel && isRecord(firstModel)) {
      return { provider, model: String(firstModel.id).trim() };
    }
  }
  return undefined;
}

function resolveAgentPrimaryModel(config: Record<string, unknown>, agentId?: string): string | undefined {
  const agents = isRecord(config.agents) ? config.agents : undefined;
  const defaults = agents && isRecord(agents.defaults) ? agents.defaults : undefined;
  const defaultsModel = defaults && isRecord(defaults.model) ? defaults.model : undefined;

  if (agentId && agents && isRecord(agents[agentId])) {
    const agentConfig = agents[agentId] as Record<string, unknown>;
    const agentModel = isRecord(agentConfig.model) ? agentConfig.model : undefined;
    if (typeof agentModel?.primary === "string" && agentModel.primary.trim()) {
      return agentModel.primary.trim();
    }
  }

  if (typeof defaultsModel?.primary === "string" && defaultsModel.primary.trim()) {
    return defaultsModel.primary.trim();
  }

  return undefined;
}

function normalizeClassificationLabels(value: unknown): MemoryClassificationLabel[] {
  if (!Array.isArray(value)) return [];
  const labels: MemoryClassificationLabel[] = [];
  const seen = new Set<MemoryCreateKind>();
  for (const item of value) {
    const record = isRecord(item) ? (item as RawMemoryClassificationLabelPayload) : undefined;
    const type =
      record?.type === "user" || record?.type === "project" || record?.type === "feedback" ? record.type : undefined;
    if (!type || seen.has(type)) continue;
    seen.add(type);
    labels.push({
      type,
      reason: typeof record?.reason === "string" ? truncateForPrompt(record.reason, 220) : "",
      evidence: typeof record?.evidence === "string" ? truncateForPrompt(record.evidence, 220) : "",
    });
  }
  return labels;
}

function buildCandidateFromCreatePayload(input: {
  kind: MemoryCreateKind;
  payload: RawMemoryCreatePayload;
  timestamp: string;
  sessionKey?: string;
}): MemoryCandidate | null {
  const name = typeof input.payload.name === "string" ? truncateForPrompt(input.payload.name, 80) : "";
  const description =
    typeof input.payload.description === "string" ? truncateForPrompt(input.payload.description, 180) : "";
  const markdown = typeof input.payload.markdown === "string" ? input.payload.markdown.trim() : "";
  if (!name || !description || !markdown) return null;
  if (input.kind === "project" && isGenericProjectCandidateName(name)) return null;
  return {
    type: input.kind,
    scope: input.kind === "user" ? "global" : "project",
    name,
    description,
    body: markdown,
    capturedAt: input.timestamp,
    ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
  };
}

function extractChatCompletionsText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    throw new Error("Invalid chat completions payload");
  }
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) {
    throw new Error("Missing chat completion message");
  }
  const content = firstChoice.message.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map(item => (isRecord(item) && typeof item.text === "string" ? item.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  throw new Error("Unsupported chat completion content shape");
}

function extractResponsesText(payload: unknown): string {
  if (!isRecord(payload)) throw new Error("Invalid responses payload");
  if (typeof payload.output_text === "string" && payload.output_text.trim()) return payload.output_text;
  if (!Array.isArray(payload.output)) throw new Error("Responses payload missing output");

  const chunks: string[] = [];
  for (const item of payload.output) {
    if (!isRecord(item) || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (isRecord(part) && typeof part.text === "string") chunks.push(part.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("Responses payload did not contain text");
  return text;
}

function extractAnthropicMessagesText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.content)) {
    throw new Error("Invalid Anthropic messages payload");
  }
  const text = payload.content
    .map(part => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic messages payload did not contain text");
  return text;
}

function extractGoogleGenerateContentText(payload: unknown): string {
  if (!isRecord(payload) || !Array.isArray(payload.candidates)) {
    throw new Error("Invalid Google generateContent payload");
  }
  const chunks: string[] = [];
  for (const candidate of payload.candidates) {
    if (!isRecord(candidate) || !isRecord(candidate.content) || !Array.isArray(candidate.content.parts)) continue;
    for (const part of candidate.content.parts) {
      if (isRecord(part) && typeof part.text === "string") chunks.push(part.text);
    }
  }
  const text = chunks.join("\n").trim();
  if (!text) throw new Error("Google generateContent payload did not contain text");
  return text;
}

function normalizeProviderApi(value: string): string {
  const api = value.trim().toLowerCase();
  return api === "gemini" ? "google" : api;
}

/**
 * 推理模型（deepseek-v4 系列/deepseek-reasoner/kimi-k2 系列/kimi-k3 等）
 * 官方约束 temperature 不可修改（kimi 传其他值报错、deepseek-v4 思考模式
 * 静默忽略）。直连构造 body 时须省略显式 temperature。
 */
function shouldOmitTemperature(model: string): boolean {
  return /deepseek-v4|deepseek-reasoner|deepseek-r1|kimi-k2|kimi-k3/.test(model.toLowerCase());
}

function buildGoogleGenerateContentUrl(baseUrl: string, model: string): string {
  const url = new URL(stripTrailingSlash(baseUrl));
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  const apiVersion = last === "v1" || last === "v1beta" ? last : "v1beta";
  const baseParts = last === "v1" || last === "v1beta" ? parts.slice(0, -1) : parts;
  url.pathname = `/${[
    ...baseParts,
    apiVersion,
    "models",
    `${encodeURIComponent(normalizeGoogleModelId(model))}:generateContent`,
  ].join("/")}`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function normalizeGoogleModelId(model: string): string {
  const withoutProvider = model.trim().startsWith("google/") ? model.trim().slice("google/".length) : model.trim();
  if (withoutProvider === "gemini-3-pro") return "gemini-3-pro-preview";
  if (withoutProvider === "gemini-3.1-pro") return "gemini-3.1-pro-preview";
  if (withoutProvider === "gemini-3-flash") return "gemini-3-flash-preview";
  if (withoutProvider === "gemini-3.1-flash" || withoutProvider === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }
  if (withoutProvider === "gemini-3.1-flash-lite") return "gemini-3.1-flash-lite-preview";
  return withoutProvider;
}

function looksLikeEnvVarName(value: string): boolean {
  return /^[A-Z0-9_]+$/.test(value);
}

type MemoryTelemetryLike = {
  trackFeatureLoopStage?: (input: Record<string, unknown>) => void;
  trackError?: (error: unknown, input?: Record<string, unknown>) => void;
};

function resolveMemoryTelemetry(runtime: Record<string, unknown> | undefined): MemoryTelemetryLike | undefined {
  const telemetry = runtime?.telemetry;
  return typeof telemetry === "object" && telemetry !== null ? (telemetry as MemoryTelemetryLike) : undefined;
}

function memoryPhaseFromLabel(label: string): "retrieve" | "capture" | "index" | "dream" {
  const normalized = label.toLowerCase();
  if (normalized.includes("retrieve") || normalized.includes("retrieval") || normalized.includes("recall"))
    return "retrieve";
  if (normalized.includes("dream") || normalized.includes("rewrite")) return "dream";
  if (normalized.includes("capture") || normalized.includes("extract")) return "capture";
  return "index";
}

export class LlmMemoryExtractor {
  constructor(
    private readonly config: Record<string, unknown>,
    private readonly runtime: Record<string, unknown> | undefined,
    private readonly logger?: LoggerLike,
  ) {}

  private resolveSelection(agentId?: string): ModelSelection {
    const modelRef = resolveAgentPrimaryModel(this.config, agentId);
    const parsed = parseModelRef(modelRef, this.config);
    if (!parsed) throw new Error("Could not resolve a model for memory extraction");

    const modelsConfig = isRecord(this.config.models) ? this.config.models : undefined;
    const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
    const providerConfig =
      providers && isRecord(providers[parsed.provider])
        ? (providers[parsed.provider] as Record<string, unknown>)
        : undefined;
    const configuredModel = Array.isArray(providerConfig?.models)
      ? providerConfig.models.find(item => isRecord(item) && item.id === parsed.model)
      : undefined;
    const modelConfig = isRecord(configuredModel) ? configuredModel : undefined;

    const api =
      typeof modelConfig?.api === "string"
        ? modelConfig.api
        : typeof providerConfig?.api === "string"
          ? providerConfig.api
          : "openai-completions";
    const baseUrl =
      typeof modelConfig?.baseUrl === "string"
        ? modelConfig.baseUrl
        : typeof providerConfig?.baseUrl === "string"
          ? providerConfig.baseUrl
          : undefined;
    const headers = {
      ...sanitizeHeaders(providerConfig?.headers),
      ...sanitizeHeaders(modelConfig?.headers),
    };

    const selection: ModelSelection = {
      provider: parsed.provider,
      model: parsed.model,
      api,
    };
    if (baseUrl?.trim()) selection.baseUrl = stripTrailingSlash(baseUrl.trim());
    if (Object.keys(headers).length > 0) selection.headers = headers;
    return selection;
  }

  private async resolveApiKey(provider: string): Promise<string> {
    const modelsConfig = isRecord(this.config.models) ? this.config.models : undefined;
    const providers = modelsConfig && isRecord(modelsConfig.providers) ? modelsConfig.providers : undefined;
    const providerConfig =
      providers && isRecord(providers[provider]) ? (providers[provider] as Record<string, unknown>) : undefined;
    const configured = typeof providerConfig?.apiKey === "string" ? providerConfig.apiKey.trim() : "";
    if (configured) {
      if (
        looksLikeEnvVarName(configured) &&
        typeof process.env[configured] === "string" &&
        process.env[configured]?.trim()
      ) {
        return process.env[configured]!.trim();
      }
      return configured;
    }

    const modelAuth =
      this.runtime && isRecord(this.runtime.modelAuth)
        ? (this.runtime.modelAuth as Record<string, unknown>)
        : undefined;
    const resolver =
      typeof modelAuth?.resolveApiKeyForProvider === "function"
        ? (modelAuth.resolveApiKeyForProvider as (params: {
            provider: string;
            cfg?: Record<string, unknown>;
          }) => Promise<{ apiKey?: string }>)
        : undefined;
    if (resolver) {
      const auth = await resolver({ provider, cfg: this.config });
      if (auth?.apiKey && String(auth.apiKey).trim()) {
        return String(auth.apiKey).trim();
      }
    }

    throw new Error(`No API key resolved for extraction provider "${provider}"`);
  }

  private async callStructuredJson(input: {
    systemPrompt: string;
    userPrompt: string;
    agentId?: string;
    requestLabel: string;
    timeoutMs?: number;
  }): Promise<string> {
    const selection = this.resolveSelection(input.agentId);
    if (!selection.baseUrl) {
      throw new Error(`${input.requestLabel} provider "${selection.provider}" does not have a baseUrl`);
    }
    const telemetry = resolveMemoryTelemetry(this.runtime);
    telemetry?.trackFeatureLoopStage?.({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: memoryPhaseFromLabel(input.requestLabel),
      loopStage: "model_request",
      outcome: "success",
      metadata: {
        provider: selection.provider,
        model: selection.model,
        providerBaseUrl: selection.baseUrl,
        requestLabel: input.requestLabel,
      },
    });
    const apiKey = await this.resolveApiKey(selection.provider);
    const headers = new Headers(selection.headers);
    if (!headers.has("content-type")) headers.set("content-type", "application/json");
    const apiType = normalizeProviderApi(selection.api);
    let url = "";
    let body: Record<string, unknown>;

    if (apiType === "openai-responses" || apiType === "responses") {
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
      url = `${selection.baseUrl}/responses`;
      body = {
        model: selection.model,
        temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
        input: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      };
    } else if (apiType === "anthropic") {
      if (!headers.has("x-api-key")) headers.set("x-api-key", apiKey);
      if (!headers.has("anthropic-version")) headers.set("anthropic-version", "2023-06-01");
      url = `${selection.baseUrl}/v1/messages`;
      body = {
        model: selection.model,
        max_tokens: 65536,
        temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
        system: input.systemPrompt,
        messages: [{ role: "user", content: input.userPrompt }],
      };
    } else if (apiType === "google") {
      if (!headers.has("x-goog-api-key")) headers.set("x-goog-api-key", apiKey);
      url = buildGoogleGenerateContentUrl(selection.baseUrl, selection.model);
      body = {
        systemInstruction: { parts: [{ text: input.systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: input.userPrompt }] }],
        generationConfig: {
          temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
          responseMimeType: "application/json",
        },
      };
    } else {
      if (!headers.has("authorization")) headers.set("authorization", `Bearer ${apiKey}`);
      url = `${selection.baseUrl}/chat/completions`;
      body = {
        model: selection.model,
        temperature: shouldOmitTemperature(selection.model) ? undefined : 0,
        stream: false,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: input.systemPrompt },
          { role: "user", content: input.userPrompt },
        ],
      };
    }

    const executeOnce = async (payloadBody: Record<string, unknown>): Promise<Response> => {
      const controller = new AbortController();
      const timeoutMs = resolveRequestTimeoutMs(input.timeoutMs);
      const timeoutId = timeoutMs === null ? null : setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(payloadBody),
          signal: controller.signal,
        });
      } catch (error) {
        if (timeoutMs !== null && error instanceof Error && error.name === "AbortError") {
          throw new Error(`${input.requestLabel} request timed out after ${timeoutMs}ms`);
        }
        throw error;
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
      }
    };

    const executeWithRetry = async (payloadBody: Record<string, unknown>): Promise<Response> => {
      let lastError: unknown = null;
      for (let attempt = 0; attempt < DEFAULT_REQUEST_MAX_ATTEMPTS; attempt += 1) {
        try {
          const response = await executeOnce(payloadBody);
          if (response.ok) return response;
          const errorText = await response.text();
          const error = Object.assign(
            new Error(`${input.requestLabel} request failed (${response.status}): ${truncate(errorText, 300)}`),
            { status: response.status },
          );
          lastError = error;
          if (!REQUEST_RETRYABLE_STATUS_CODES.has(response.status) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
            throw error;
          }
        } catch (error) {
          lastError = error;
          if (!isTransientRequestError(error) || attempt >= DEFAULT_REQUEST_MAX_ATTEMPTS - 1) {
            throw error;
          }
        }
        await sleep(computeRetryDelayMs(attempt));
      }
      throw lastError instanceof Error ? lastError : new Error(`${input.requestLabel} request failed`);
    };

    let response: Response;
    try {
      response = await executeWithRetry(body);
    } catch (error) {
      if (!("response_format" in body)) {
        telemetry?.trackError?.(error, {
          module: "memory",
          ownerModule: "memory",
          executionKind: "memory",
          phase: memoryPhaseFromLabel(input.requestLabel),
          loopStage: "model_request",
          errorCategory: "model_request_error",
          metadata: {
            provider: selection.provider,
            model: selection.model,
            providerBaseUrl: selection.baseUrl,
          },
        });
        throw error;
      }
      const fallbackBody = { ...body };
      delete fallbackBody.response_format;
      try {
        response = await executeWithRetry(fallbackBody);
      } catch (fallbackError) {
        telemetry?.trackError?.(fallbackError, {
          module: "memory",
          ownerModule: "memory",
          executionKind: "memory",
          phase: memoryPhaseFromLabel(input.requestLabel),
          loopStage: "model_request",
          errorCategory: "model_request_error",
          metadata: {
            provider: selection.provider,
            model: selection.model,
            providerBaseUrl: selection.baseUrl,
          },
        });
        throw fallbackError;
      }
    }

    const payload = await response.json();
    telemetry?.trackFeatureLoopStage?.({
      module: "memory",
      ownerModule: "memory",
      executionKind: "memory",
      phase: memoryPhaseFromLabel(input.requestLabel),
      loopStage: "model_response",
      outcome: "success",
      metadata: {
        provider: selection.provider,
        model: selection.model,
        providerBaseUrl: selection.baseUrl,
        requestLabel: input.requestLabel,
      },
    });
    if (apiType === "openai-responses" || apiType === "responses") return extractResponsesText(payload);
    if (apiType === "anthropic") return extractAnthropicMessagesText(payload);
    if (apiType === "google") return extractGoogleGenerateContentText(payload);
    return extractChatCompletionsText(payload);
  }

  private async callStructuredJsonWithDebug<T>(input: {
    systemPrompt: string;
    userPrompt: string;
    agentId?: string;
    requestLabel: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
    parse: (raw: string) => T;
  }): Promise<T> {
    let rawResponse = "";
    try {
      rawResponse = await this.callStructuredJson(input);
      const parsedResult = input.parse(rawResponse);
      input.debugTrace?.({
        requestLabel: input.requestLabel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        rawResponse,
        parsedResult,
      });
      return parsedResult;
    } catch (error) {
      input.debugTrace?.({
        requestLabel: input.requestLabel,
        systemPrompt: input.systemPrompt,
        userPrompt: input.userPrompt,
        rawResponse,
        errored: true,
        timedOut: isTimeoutError(error) || (error instanceof Error && /timed out/i.test(error.message)),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async rewriteUserProfile(input: {
    existingProfile: MemoryUserSummary | null;
    candidates: MemoryCandidate[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ candidate: MemoryCandidate; absorbedNoteIndexes: number[] } | null> {
    const userCandidates = input.candidates.filter(candidate => candidate.type === "user");
    if (userCandidates.length === 0) return null;

    const latestCandidate = userCandidates[userCandidates.length - 1];
    try {
      const parsed = await this.callStructuredJsonWithDebug<RawUserProfilePayload>({
        systemPrompt: USER_PROFILE_REWRITE_SYSTEM_PROMPT,
        userPrompt: buildUserProfileRewritePrompt(input),
        requestLabel: "User profile rewrite",
        timeoutMs: input.timeoutMs ?? DEFAULT_USER_PROFILE_REWRITE_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawUserProfilePayload,
      });
      const candidate = buildRewrittenUserProfileCandidate({
        sectionMarkdown: parsed.identity_background_markdown ?? parsed.identity_background ?? "",
        latestCandidate,
      });
      if (!candidate) return null;
      // Only notes the model explicitly reports as absorbed may be deleted
      // by the caller; an absent/malformed note_absorption keeps every note.
      const absorbedNoteIndexes: number[] = [];
      if (Array.isArray(parsed.note_absorption)) {
        for (const entry of parsed.note_absorption) {
          if (!entry || entry.absorbed !== true) continue;
          // 显式缺失/空索引一律不吸收（Number(null)===0 会误删笔记 0）
          if (entry.note_index === null || entry.note_index === undefined || entry.note_index === "") continue;
          const index = typeof entry.note_index === "number" ? entry.note_index : Number(entry.note_index);
          if (Number.isInteger(index) && index >= 0 && index < userCandidates.length) {
            absorbedNoteIndexes.push(index);
          }
        }
      }
      return { candidate, absorbedNoteIndexes: [...new Set(absorbedNoteIndexes)] };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] user profile rewrite failed: ${String(error)}`);
    }

    return null;
  }

  async classifyMemoryTurn(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<FileMemoryClassificationResult> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<RawMemoryClassificationPayload>({
        systemPrompt: MEMORY_CLASSIFICATION_SYSTEM_PROMPT,
        userPrompt: buildIndexPromptWindow({
          batchContextMessages: input.batchContextMessages,
          focusUserTurn: input.focusUserTurn,
          currentProjectMeta: input.currentProjectMeta,
        }),
        requestLabel: "Memory turn classification",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawMemoryClassificationPayload,
      });
      const labels = normalizeClassificationLabels(parsed.labels);
      const shouldStore = Boolean(parsed.should_store) && labels.length > 0;
      return { shouldStore, labels };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] memory turn classification fallback: ${String(error)}`);
      return { shouldStore: false, labels: [] };
    }
  }

  private async createMemoryNote(input: {
    kind: MemoryCreateKind;
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    const requestLabel =
      input.kind === "user"
        ? "User memory create"
        : input.kind === "project"
          ? "Project memory create"
          : "Feedback memory create";
    const systemPrompt =
      input.kind === "user"
        ? USER_NOTE_CREATE_SYSTEM_PROMPT
        : input.kind === "project"
          ? PROJECT_NOTE_CREATE_SYSTEM_PROMPT
          : FEEDBACK_NOTE_CREATE_SYSTEM_PROMPT;
    const userPrompt = JSON.stringify(
      {
        classification: {
          type: input.classification.type,
          reason: input.classification.reason,
          evidence: input.classification.evidence,
        },
        context: JSON.parse(
          buildIndexPromptWindow({
            batchContextMessages: input.batchContextMessages,
            focusUserTurn: input.focusUserTurn,
            currentProjectMeta: input.currentProjectMeta,
          }),
        ),
      },
      null,
      2,
    );

    let rawResponse = "";
    try {
      rawResponse = await this.callStructuredJson({
        systemPrompt,
        userPrompt,
        requestLabel,
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
      });
      let parsed: RawMemoryCreatePayload;
      let parseMode: "strict" | "fallback" = "strict";
      let strictParseError = "";
      try {
        parsed = JSON.parse(extractFirstJsonObject(rawResponse)) as RawMemoryCreatePayload;
      } catch (error) {
        strictParseError = error instanceof Error ? error.message : String(error);
        const fallback = tryParseLooseMemoryCreatePayload(rawResponse);
        if (!fallback) throw error;
        parsed = fallback;
        parseMode = "fallback";
      }
      input.debugTrace?.({
        requestLabel,
        systemPrompt,
        userPrompt,
        rawResponse,
        parsedResult:
          parseMode === "strict"
            ? parsed
            : {
                parseMode,
                strictParseError,
                payload: parsed,
              },
      });
      if (parsed.skip === true) return null;
      return buildCandidateFromCreatePayload({
        kind: input.kind,
        payload: parsed,
        timestamp: input.timestamp,
        ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
      });
    } catch (error) {
      input.debugTrace?.({
        requestLabel,
        systemPrompt,
        userPrompt,
        rawResponse,
        errored: true,
        timedOut: isTimeoutError(error) || (error instanceof Error && /timed out/i.test(error.message)),
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      this.logger?.warn?.(`[clawxmemory] ${requestLabel.toLowerCase()} fallback: ${String(error)}`);
      return null;
    }
  }

  async createUserMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "user" });
  }

  async createProjectMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "project" });
  }

  async createFeedbackMemoryNote(input: {
    timestamp: string;
    sessionKey?: string;
    focusUserTurn: MemoryMessage;
    batchContextMessages: MemoryMessage[];
    currentProjectMeta?: ProjectMetaRecord | null;
    classification: MemoryClassificationLabel;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryCandidate | null> {
    return this.createMemoryNote({ ...input, kind: "feedback" });
  }

  async planDreamClusters(input: LlmDreamClusterPlanInput): Promise<LlmDreamClusterPlanOutput> {
    if (input.headers.length < 2) {
      return {
        summary: `Not enough ${input.kind} files to form Dream clusters.`,
        clusters: [],
      };
    }
    const allowedRelativePaths = new Set(input.headers.map(header => header.relativePath));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamClusterPlanPayload>({
      systemPrompt: buildDreamClusterPlanSystemPrompt(input.kind),
      userPrompt: buildDreamClusterPlanPrompt(input),
      requestLabel: input.kind === "project" ? "Dream project cluster plan" : "Dream feedback cluster plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_CLUSTER_PLAN_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawDreamClusterPlanPayload,
    });
    return {
      summary:
        typeof parsed.summary === "string"
          ? truncate(normalizeWhitespace(parsed.summary), 320)
          : `Dream ${input.kind} cluster plan completed.`,
      clusters: Array.isArray(parsed.clusters)
        ? parsed.clusters
            .map(cluster => normalizeDreamCluster(cluster, allowedRelativePaths))
            .filter((cluster): cluster is LlmDreamCluster => Boolean(cluster))
        : [],
    };
  }

  async refineDreamCluster(input: LlmDreamClusterRefineInput): Promise<LlmDreamClusterRefineOutput> {
    if (input.records.length === 0) {
      return {
        summary: `No ${input.kind} files were supplied for Dream refine.`,
        file: null,
      };
    }
    const parsed = await this.callStructuredJsonWithDebug<RawDreamClusterRefinePayload>({
      systemPrompt: buildDreamClusterRefineSystemPrompt(input.kind),
      userPrompt: buildDreamClusterRefinePrompt(input),
      requestLabel: input.kind === "project" ? "Dream project cluster refine" : "Dream feedback cluster refine",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_CLUSTER_REFINE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawDreamClusterRefinePayload,
    });
    const name = typeof parsed.name === "string" ? truncate(normalizeWhitespace(parsed.name), 120) : "";
    const description =
      typeof parsed.description === "string" ? truncate(normalizeWhitespace(parsed.description), 320) : "";
    const markdown = typeof parsed.markdown === "string" ? parsed.markdown.trim() : "";
    return {
      summary:
        typeof parsed.summary === "string"
          ? truncate(normalizeWhitespace(parsed.summary), 320)
          : `Dream ${input.kind} cluster refine completed.`,
      file: name && description && markdown ? { name, description, markdown } : null,
    };
  }

  async planGeneralProjectMetaMerges(
    input: LlmGeneralProjectMetaMergeInput,
  ): Promise<LlmGeneralProjectMetaMergeOutput> {
    if (input.projectMetas.length < 2) {
      return {
        summary: "Fewer than two General project metadata records were available for merge planning.",
        mergeGroups: [],
      };
    }
    const parsed = await this.callStructuredJsonWithDebug<RawGeneralProjectMetaMergePlanPayload>({
      systemPrompt: GENERAL_PROJECT_META_MERGE_SYSTEM_PROMPT,
      userPrompt: buildGeneralProjectMetaMergePrompt(input),
      requestLabel: "General project meta merge plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_GENERAL_PROJECT_META_MERGE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawGeneralProjectMetaMergePlanPayload,
    });
    return {
      summary:
        typeof parsed.summary === "string"
          ? truncate(normalizeWhitespace(parsed.summary), 320)
          : "General project meta merge planning completed.",
      mergeGroups: Array.isArray(parsed.merge_groups)
        ? parsed.merge_groups
            .map(group => normalizeGeneralProjectMetaMergeGroup(group))
            .filter((group): group is LlmGeneralProjectMetaMergeGroup => Boolean(group))
        : [],
    };
  }

  async reviewDreamProjectMeta(input: LlmDreamProjectMetaReviewInput): Promise<LlmDreamProjectMetaReviewOutput> {
    const fallback = {
      projectName: input.currentMeta.projectName,
      description: input.currentMeta.description,
      status: input.currentMeta.status,
    };
    const parsed = await this.callStructuredJsonWithDebug<RawProjectMetaReviewPayload>({
      systemPrompt: DREAM_PROJECT_META_REVIEW_SYSTEM_PROMPT,
      userPrompt: buildDreamProjectMetaReviewPrompt(input),
      requestLabel: "Dream project meta review",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_PROJECT_META_REVIEW_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawProjectMetaReviewPayload,
    });
    return normalizeDreamProjectMetaReview(parsed, fallback);
  }

  async planDreamFileMemory(input: LlmDreamFileGlobalPlanInput): Promise<LlmDreamFileGlobalPlanOutput> {
    if (input.records.length === 0) {
      return {
        summary: "No project memory files were available for Dream planning.",
        duplicateTopicCount: 0,
        conflictTopicCount: 0,
        projects: [],
        deletedProjectIds: [],
        deletedEntryIds: [],
      };
    }

    const allowedEntryIds = new Set(input.records.map(record => record.entryId));
    const allowedProjectIds = new Set(input.currentProjects.map(project => project.projectId));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamFileGlobalPlanPayload>({
      systemPrompt: DREAM_FILE_GLOBAL_PLAN_SYSTEM_PROMPT,
      userPrompt: buildDreamFileGlobalPlanPrompt(input),
      requestLabel: "Dream file global plan",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_FILE_PLAN_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawDreamFileGlobalPlanPayload,
    });
    const projects = Array.isArray(parsed.projects)
      ? parsed.projects
          .map((item, index) => normalizeDreamFileGlobalPlanProject(item, allowedEntryIds, allowedProjectIds, index))
          .filter((item): item is LlmDreamFileGlobalPlanProject => Boolean(item))
      : [];
    const deletedProjectIds = Array.from(
      new Set(
        normalizeStringArray(parsed.deleted_project_ids, 200)
          .map(item => normalizeWhitespace(item))
          .filter(item => allowedProjectIds.has(item)),
      ),
    );
    const deletedEntryIds = normalizeDreamFileEntryIds(parsed.deleted_entry_ids, allowedEntryIds, 400);
    return {
      summary:
        typeof parsed.summary === "string"
          ? truncate(normalizeWhitespace(parsed.summary), 320)
          : "Dream file global plan completed.",
      duplicateTopicCount: Math.max(
        0,
        Math.floor(typeof parsed.duplicate_topic_count === "number" ? parsed.duplicate_topic_count : 0),
      ),
      conflictTopicCount: Math.max(
        0,
        Math.floor(typeof parsed.conflict_topic_count === "number" ? parsed.conflict_topic_count : 0),
      ),
      projects,
      deletedProjectIds,
      deletedEntryIds,
    };
  }

  async rewriteDreamFileProject(input: LlmDreamFileProjectRewriteInput): Promise<LlmDreamFileProjectRewriteOutput> {
    if (input.records.length === 0) {
      throw new Error("No memory files were supplied for Dream project rewrite.");
    }
    const allowedEntryIds = new Set(input.records.map(record => record.entryId));
    const parsed = await this.callStructuredJsonWithDebug<RawDreamFileProjectRewritePayload>({
      systemPrompt: DREAM_FILE_PROJECT_REWRITE_SYSTEM_PROMPT,
      userPrompt: buildDreamFileProjectRewritePrompt(input),
      requestLabel: "Dream file project rewrite",
      timeoutMs: input.timeoutMs ?? DEFAULT_DREAM_FILE_PROJECT_REWRITE_TIMEOUT_MS,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
      parse: raw => JSON.parse(extractFirstJsonObject(raw)) as RawDreamFileProjectRewritePayload,
    });
    const files = Array.isArray(parsed.files)
      ? parsed.files
          .map(item => normalizeDreamFileProjectRewriteFile(item, allowedEntryIds))
          .filter((item): item is LlmDreamFileProjectRewriteOutputFile => Boolean(item))
      : [];
    const fallbackMeta = {
      projectName: input.project.projectName,
      description: input.project.description,
      status: input.project.status,
    };
    return {
      summary:
        typeof parsed.summary === "string"
          ? truncate(normalizeWhitespace(parsed.summary), 320)
          : `Dream rewrite completed for ${input.project.projectName}.`,
      projectMeta: normalizeDreamFileProjectMetaPayload(parsed.project_meta, fallbackMeta),
      files,
      deletedEntryIds: normalizeDreamFileEntryIds(parsed.deleted_entry_ids, allowedEntryIds, 400),
    };
  }

  async decideFileMemoryRoute(input: {
    query: string;
    recentMessages?: MemoryMessage[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<MemoryRoute> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ route?: unknown }>({
        systemPrompt: [
          "You decide whether the current query should trigger long-term memory recall.",
          "Return JSON only with a single field route.",
          "Valid route values: none, user, project, mix.",
          "Use none unless the query clearly needs long-term memory.",
          "Use user only when the query is asking about stable personal identity/background facts about who the user is, such as name, profession, long-term role context, life background, or durable relationships.",
          "Do not use user for reply preferences, language choices, formatting rules, style guidance, file/tool boundaries, or delivery rules; those belong to project.",
          "Use project when the query only needs current project memory, including project facts, collaboration rules, delivery style, file boundaries, or project status.",
          "Use mix only when the query genuinely needs both current project memory and the user's stable identity/background at the same time.",
          "Do not use mix just because both could be helpful; choose mix only when both are actually necessary to answer well.",
        ].join("\n"),
        userPrompt: JSON.stringify(
          {
            query: input.query,
            recent_messages: (input.recentMessages ?? []).slice(-4).map(message => ({
              role: message.role,
              content: truncateForPrompt(message.content, 220),
            })),
          },
          null,
          2,
        ),
        requestLabel: "File memory gate",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_GATE_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw => JSON.parse(extractFirstJsonObject(raw)) as { route?: unknown },
      });
      return normalizeMemoryRoute(parsed.route) || "none";
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory gate fallback: ${String(error)}`);
      return "none";
    }
  }

  async selectRecallProject(input: {
    query: string;
    recentUserMessages?: MemoryMessage[];
    shortlist: ProjectShortlistCandidate[];
    allowEmpty?: boolean;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ projectId?: string; reason?: string }> {
    if (input.shortlist.length === 0) return {};
    const fallbackProject = chooseBestRecallProjectFallback(input.shortlist);
    const allowEmpty = Boolean(input.allowEmpty);
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ selected_project_id?: unknown; reason?: unknown }>({
        systemPrompt: [
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
        ].join("\n"),
        userPrompt: JSON.stringify(
          {
            query: input.query,
            recent_user_messages: (input.recentUserMessages ?? [])
              .slice(-4)
              .map(message => truncateForPrompt(message.content, 220)),
            shortlist: input.shortlist.map(project => ({
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
        ),
        requestLabel: "File memory project selection",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw => JSON.parse(extractFirstJsonObject(raw)) as { selected_project_id?: unknown; reason?: unknown },
      });
      const selectedProjectId = typeof parsed.selected_project_id === "string" ? parsed.selected_project_id.trim() : "";
      const matched = input.shortlist.find(project => project.projectId === selectedProjectId);
      if (matched) {
        return {
          projectId: matched.projectId,
          ...(typeof parsed.reason === "string" && parsed.reason.trim()
            ? { reason: truncateForPrompt(parsed.reason, 220) }
            : {}),
        };
      }
      if (allowEmpty) {
        return {
          ...(typeof parsed.reason === "string" && parsed.reason.trim()
            ? { reason: truncateForPrompt(parsed.reason, 220) }
            : {
                reason: selectedProjectId
                  ? "Model returned a project id outside the shortlist."
                  : "Model returned no matching project.",
              }),
        };
      }
      return {
        projectId: fallbackProject.projectId,
        ...(typeof parsed.reason === "string" && parsed.reason.trim()
          ? { reason: truncateForPrompt(parsed.reason, 220) }
          : { reason: `Fallback selected ${fallbackProject.projectName}; model returned no valid project id.` }),
      };
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory project selection fallback: ${String(error)}`);
      if (allowEmpty) {
        return {
          reason: "Project selection failed; no existing project was forced.",
        };
      }
      return {
        projectId: fallbackProject.projectId,
        reason: `Fallback selected ${fallbackProject.projectName}; project selection failed.`,
      };
    }
  }

  async selectIndexProject(input: {
    candidate: MemoryCandidate;
    candidatePreview: string;
    focusTurn: MemoryMessage;
    recentUserMessages?: MemoryMessage[];
    shortlist: ProjectShortlistCandidate[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<{ decision: "attach_existing" | "create_new"; projectId?: string; reason?: string }> {
    if (input.shortlist.length === 0) {
      return {
        decision: "create_new",
        reason: "No existing General projects are available for index assignment.",
      };
    }
    try {
      const parsed = await this.callStructuredJsonWithDebug<{
        decision?: unknown;
        selected_project_id?: unknown;
        reason?: unknown;
      }>({
        systemPrompt: [
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
        ].join("\n"),
        userPrompt: JSON.stringify(
          {
            candidate: {
              type: input.candidate.type,
              name: truncateForPrompt(input.candidate.name, 120),
              description: truncateForPrompt(input.candidate.description, 220),
              rule: input.candidate.rule ? truncateForPrompt(input.candidate.rule, 220) : null,
              summary: input.candidate.summary ? truncateForPrompt(input.candidate.summary, 220) : null,
              why: input.candidate.why ? truncateForPrompt(input.candidate.why, 220) : null,
              how_to_apply: input.candidate.howToApply ? truncateForPrompt(input.candidate.howToApply, 220) : null,
              stage: input.candidate.stage ? truncateForPrompt(input.candidate.stage, 220) : null,
              decisions: (input.candidate.decisions ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
              constraints: (input.candidate.constraints ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
              next_steps: (input.candidate.nextSteps ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
              blockers: (input.candidate.blockers ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
              timeline: (input.candidate.timeline ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
              notes: (input.candidate.notes ?? []).slice(0, 10).map(item => truncateForPrompt(item, 160)),
            },
            candidate_memory_preview: truncateForPrompt(input.candidatePreview, 1600),
            focus_user_turn: truncateForPrompt(input.focusTurn.content, 360),
            recent_user_messages: (input.recentUserMessages ?? [])
              .slice(-4)
              .map(message => truncateForPrompt(message.content, 220)),
            shortlist: input.shortlist.map(project => ({
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
        ),
        requestLabel: "File memory project assignment",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_PROJECT_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw =>
          JSON.parse(extractFirstJsonObject(raw)) as {
            decision?: unknown;
            selected_project_id?: unknown;
            reason?: unknown;
          },
      });
      const decision = parsed.decision === "attach_existing" ? "attach_existing" : "create_new";
      const selectedProjectId = typeof parsed.selected_project_id === "string" ? parsed.selected_project_id.trim() : "";
      const matched = input.shortlist.find(project => project.projectId === selectedProjectId);
      const reason =
        typeof parsed.reason === "string" && parsed.reason.trim() ? truncateForPrompt(parsed.reason, 260) : "";
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
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory project assignment fallback: ${String(error)}`);
      return {
        decision: "create_new",
        reason: "Project assignment failed; creating a new General project is safer than forcing an existing project.",
      };
    }
  }

  async selectFileManifestEntries(input: {
    query: string;
    route: MemoryRoute;
    recentUserMessages?: MemoryMessage[];
    projectMeta?: ProjectMetaRecord;
    manifest: RecallHeaderEntry[];
    limit?: number;
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
  }): Promise<string[]> {
    try {
      const parsed = await this.callStructuredJsonWithDebug<{ selected_ids?: unknown }>({
        systemPrompt: [
          "You select a small number of memory files from a compact manifest.",
          "Return JSON only with selected_ids.",
          "Select at most 5 ids and prefer recent items that are directly useful for the query.",
        ].join("\n"),
        userPrompt: JSON.stringify(
          {
            query: input.query,
            route: input.route,
            recent_user_messages: (input.recentUserMessages ?? [])
              .slice(-4)
              .map(message => truncateForPrompt(message.content, 220)),
            project: input.projectMeta
              ? {
                  project_id: input.projectMeta.projectId,
                  project_name: input.projectMeta.projectName,
                  description: truncateForPrompt(input.projectMeta.description, 180),
                  status: input.projectMeta.status,
                }
              : null,
            manifest: input.manifest.slice(0, 200).map(entry => ({
              id: entry.relativePath,
              type: entry.type,
              scope: entry.scope,
              project_id: entry.projectId ?? null,
              updated_at: entry.updatedAt,
              description: truncateForPrompt(entry.description, 200),
            })),
            limit: Math.max(1, Math.min(5, input.limit ?? 5)),
          },
          null,
          2,
        ),
        requestLabel: "File memory selection",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_SELECTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw => JSON.parse(extractFirstJsonObject(raw)) as { selected_ids?: unknown },
      });
      const selected = normalizeStringArray(parsed.selected_ids, Math.max(1, Math.min(5, input.limit ?? 5)));
      return selected;
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory selection fallback: ${String(error)}`);
      return [];
    }
  }

  async extractFileMemoryCandidates(input: {
    timestamp: string;
    sessionKey?: string;
    messages: MemoryMessage[];
    batchContextMessages?: MemoryMessage[];
    knownProjects?: ProjectIdentityHint[];
    agentId?: string;
    timeoutMs?: number;
    debugTrace?: PromptDebugSink;
    decisionTrace?: (debug: FileMemoryExtractionDebug) => void;
  }): Promise<MemoryCandidate[]> {
    const focusMessages = input.messages.filter(message => message.role === "user");
    if (focusMessages.length === 0) return [];
    const batchContextMessages = input.batchContextMessages?.length ? input.batchContextMessages : input.messages;
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
    const uniqueBatchProjectName = extractUniqueBatchProjectName(batchContextMessages);
    const selectedKnownProject = selectKnownProjectHint(focusText, input.knownProjects ?? []);
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

    try {
      const parsed = await this.callStructuredJsonWithDebug<{ items?: unknown[] }>({
        systemPrompt: [
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
          "Treat explicit collaboration instructions as feedback. Example: '在这个项目里，每次给我交付时都先给3个标题，再给正文，再给封面文案。'",
          "When a transcript names a project, describes what the project is, or states its current stage, emit a project item unless the content is obviously too transient.",
          "Do not create placeholder project names like overview, project, or memory-item.",
          "Generic anchors such as '这个项目' only become project memory when the batch context provides a unique project identity.",
          'If no durable memory should be saved, return {"items":[]}.',
        ].join("\n"),
        userPrompt: JSON.stringify(
          {
            timestamp: input.timestamp,
            known_projects: (input.knownProjects ?? []).slice(0, 20).map(project => ({
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
        ),
        requestLabel: "File memory extraction",
        timeoutMs: input.timeoutMs ?? DEFAULT_FILE_MEMORY_EXTRACTION_TIMEOUT_MS,
        ...(input.agentId ? { agentId: input.agentId } : {}),
        ...(input.debugTrace ? { debugTrace: input.debugTrace } : {}),
        parse: raw => JSON.parse(extractFirstJsonObject(raw)) as { items?: unknown[] },
      });
      if (!Array.isArray(parsed.items)) {
        input.decisionTrace?.({
          parsedItems: [],
          normalizedCandidates: [],
          discarded: [
            {
              reason: "invalid_schema",
              summary: "Model output did not contain an items array.",
            },
          ],
          finalCandidates: [],
        });
        return [];
      }
      const discarded: FileMemoryExtractionDiscardedCandidate[] = [];
      const parsedItems = parsed.items.filter(isRecord);
      const items = parsedItems
        .map((item): MemoryCandidate | null => {
          const type =
            item.type === "feedback" || item.type === "project" ? item.type : item.type === "user" ? "user" : null;
          if (!type) {
            discarded.push({
              reason: "invalid_schema",
              summary: typeof item.type === "string" ? `Unsupported type: ${item.type}` : "Missing candidate type.",
            });
            return null;
          }
          const rawName = typeof item.name === "string" ? truncateForPrompt(item.name, 80) : "";
          const rawProjectName = typeof item.project_name === "string" ? truncateForPrompt(item.project_name, 80) : "";
          const rawProjectId = typeof item.project_id === "string" ? truncateForPrompt(item.project_id, 80) : "";
          const rawContent =
            typeof item.content === "string" ? truncateForPrompt(normalizeWhitespace(item.content), 280) : "";
          const feedbackRule =
            typeof item.rule === "string" ? truncateForPrompt(normalizeWhitespace(item.rule), 220) : "";
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
            rawDecisions[0] ||
              rawConstraints[0] ||
              rawNextSteps[0] ||
              rawBlockers[0] ||
              timeline[0] ||
              rawNotes[0] ||
              "",
            180,
          );
          if (type === "feedback" && !feedbackRule) {
            discarded.push({
              reason: "invalid_schema",
              candidateType: type,
              ...(rawName || typeof item.name === "string"
                ? { candidateName: rawName || String(item.name).trim() }
                : {}),
              summary: "Feedback candidate missing a non-empty rule.",
            });
            return null;
          }
          const candidateType = type;
          const shouldPinToKnownProject = Boolean(selectedKnownProject && !explicitProjectName);
          const projectNameFallback =
            candidateType === "project"
              ? truncateForPrompt(
                  explicitProjectName ||
                    (shouldPinToKnownProject ? (selectedKnownProject?.projectName ?? "") : "") ||
                    rawName ||
                    rawProjectName ||
                    (isLikelyHumanReadableProjectIdentifier(rawProjectId) ? rawProjectId : "") ||
                    extractProjectNameFromContent(rawContent) ||
                    contextProjectName,
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
                      : explicitProjectDescriptor
                        ? explicitProjectDescriptor
                        : explicitGoal
                          ? explicitGoal
                          : rawStage
                            ? truncateForPrompt(rawStage, 180)
                            : explicitProjectStage
                              ? truncateForPrompt(explicitProjectStage, 180)
                              : structuredProjectSummary);
          const normalizedProjectDescription =
            candidateType === "project" &&
            structuredProjectSummary &&
            (!description || description === explicitProjectDescriptor || description === explicitGoal)
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
            candidateType === "project" && projectScopeSignal
              ? uniqueStrings([...rawDecisions, normalizeWhitespace(stripExplicitRememberLead(focusText))], 10)
              : rawDecisions;
          const nextSteps = rawNextSteps;
          const blockers =
            candidateType === "project" && projectRiskSignal
              ? uniqueStrings([...rawBlockers, normalizeWhitespace(stripExplicitRememberLead(focusText))], 10)
              : rawBlockers;
          const notes =
            candidateType === "project" && !projectScopeSignal && !projectRiskSignal
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
            discarded.push({
              reason: "invalid_schema",
              candidateType,
              ...(name || rawName ? { candidateName: name || rawName } : {}),
              summary: "Candidate missing a stable name or description.",
            });
            return null;
          }
          if (candidateType === "user" && (!name || !hasUserPayload)) {
            discarded.push({
              reason: "invalid_schema",
              candidateType,
              candidateName: "user-profile",
              summary: "User candidate did not contain any durable profile content.",
            });
            return null;
          }
          if (candidateType === "project" && isGenericProjectCandidateName(name)) {
            discarded.push({
              reason: "generic_project_name",
              candidateType,
              candidateName: name,
              summary: description,
            });
            return null;
          }
          return {
            type: candidateType,
            scope: candidateType === "user" ? "global" : "project",
            ...(() => {
              if (candidateType !== "project" && candidateType !== "feedback") return {};
              if (typeof item.project_id === "string" && isStableFormalProjectId(item.project_id)) {
                return { projectId: item.project_id.trim() };
              }
              if (selectedKnownProject?.projectId && isStableFormalProjectId(selectedKnownProject.projectId)) {
                return { projectId: selectedKnownProject.projectId };
              }
              return {};
            })(),
            name,
            description: normalizedProjectDescription,
            ...(input.sessionKey ? { sourceSessionKey: input.sessionKey } : {}),
            capturedAt: input.timestamp,
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
          };
        })
        .filter((item): item is MemoryCandidate => Boolean(item));
      const filtered = items.filter(item => {
        const hasStructuredProjectEvidence =
          item.type === "project" &&
          Boolean(
            item.stage ||
              item.constraints?.length ||
              item.decisions?.length ||
              item.nextSteps?.length ||
              item.blockers?.length ||
              item.timeline?.length ||
              item.notes?.length,
          );
        const text = [
          item.description,
          item.summary ?? "",
          item.rule ?? "",
          item.stage ?? "",
          ...(item.preferences ?? []),
          ...(item.notes ?? []),
          ...(item.nextSteps ?? []),
          ...(item.blockers ?? []),
          ...(item.timeline ?? []),
        ].join(" ");
        if (item.type === "user") {
          return true;
        }
        if (item.type === "project") {
          if (feedbackInstructionSignal && !projectDefinitionSignal) {
            discarded.push({
              reason: "violates_feedback_project_boundary",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
          if (genericProjectAnchor && !projectDefinitionSignal && !contextProjectName) {
            discarded.push({
              reason: "generic_anchor_without_unique_project",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
          if (
            genericProjectAnchor &&
            !projectDefinitionSignal &&
            contextProjectName &&
            !hasStructuredProjectEvidence &&
            !projectFollowUpSignal &&
            !looksLikeConcreteProjectMemoryText(text) &&
            !looksLikeProjectFollowUpText(text)
          ) {
            discarded.push({
              reason: "generic_anchor_without_project_definition",
              candidateType: item.type,
              candidateName: item.name,
              summary: item.description,
            });
            return false;
          }
        }
        if (item.type === "feedback" && projectDefinitionSignal && !feedbackInstructionSignal) {
          discarded.push({
            reason: "violates_feedback_project_boundary",
            candidateType: item.type,
            candidateName: item.name,
            summary: item.description,
          });
          return false;
        }
        return true;
      });
      const syntheticProjectFallback =
        filtered.length === 0 &&
        !feedbackInstructionSignal &&
        contextProjectName &&
        (projectFollowUpSignal ||
          projectRiskSignal ||
          projectScopeSignal ||
          (genericProjectAnchor && looksLikeConcreteProjectMemoryText(focusText)))
          ? buildSyntheticProjectFollowUpCandidate({
              focusText,
              timestamp: input.timestamp,
              ...(input.sessionKey ? { sessionKey: input.sessionKey } : {}),
              uniqueBatchProjectName: contextProjectName,
              explicitProjectName,
              explicitProjectDescriptor,
              explicitProjectStage,
              explicitTimeline,
              explicitGoal,
              explicitBlocker,
            })
          : null;
      const finalCandidates = syntheticProjectFallback ? [syntheticProjectFallback] : filtered;
      input.decisionTrace?.({
        parsedItems,
        normalizedCandidates: items,
        discarded,
        finalCandidates,
      });
      return finalCandidates;
    } catch (error) {
      this.logger?.warn?.(`[clawxmemory] file memory extraction fallback: ${String(error)}`);
      input.decisionTrace?.({
        parsedItems: [],
        normalizedCandidates: [],
        discarded: [
          {
            reason: "extract_error",
            summary: error instanceof Error ? error.message : String(error),
          },
        ],
        finalCandidates: [],
      });
      return [];
    }
  }
}
