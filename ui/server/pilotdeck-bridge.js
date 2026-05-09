/**
 * PilotDeck bridge — the only chat-execution entry point in `ui/server/`.
 *
 * The Web UI keeps speaking the legacy WebSocket protocol (`*-command`,
 * `abort-session`, `claude-permission-response`, NormalizedMessage event
 * frames). This module:
 *
 *   1. Spins up a singleton in-process PilotDeck gateway on first use.
 *   2. Maps each old "sessionId" → PilotDeck "sessionKey" (1:1, generated
 *      on first turn and remembered for resume).
 *   3. Translates GatewayEvent → NormalizedMessage and writes back via
 *      `writer.send(...)` so the existing UI rendering pipeline stays
 *      unchanged.
 *   4. Tracks active runs so `abort-session` and the `complete` ack work.
 *
 * Anything that is NOT chat execution (project listing, files, git, mcp,
 * skills, taskmaster, memory, cron management) still runs through the
 * existing `ui/server/` route handlers — those are local/disk operations
 * that do not need an agent runtime.
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import {
    createLocalGateway,
    getLocalGatewayRouterStats,
} from '../../dist/src/cli/createLocalGateway.js';
import { SessionConfigOverrides } from '../../dist/src/always-on/runtime/SessionConfigOverrides.js';
import { createNormalizedMessage } from './pilotdeck-message.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** @type {import('../../dist/src/gateway/index.js').Gateway | null} */
let gateway = null;
let gatewayInitError = null;
const sessionOverrides = new SessionConfigOverrides();

/**
 * Default permission mode for sessions started from the Web UI. We use
 * `default` so PilotDeck's `Permission.decide()` fully evaluates rules
 * + tool semantics — read-only tools allow, side-effecting tools either
 * match an `allow` rule (set by clicking "Permission added" in the UI)
 * or surface a `permission_required` tool error. Override with
 * `PILOTDECK_WEB_PERMISSION_MODE`.
 */
const WEB_DEFAULT_PERMISSION_MODE =
    process.env.PILOTDECK_WEB_PERMISSION_MODE || 'default';

function ensureGateway() {
    if (gateway) return gateway;
    if (gatewayInitError) throw gatewayInitError;
    try {
        gateway = createLocalGateway({
            projectRoot: REPO_ROOT,
            sessionOverrides,
        });
        return gateway;
    } catch (error) {
        gatewayInitError = error;
        throw error;
    }
}

/**
 * Public accessor for the singleton gateway. Other ui/server modules
 * (projects.js etc.) call this so they share the same in-process
 * runtime as `runChatViaGateway` instead of constructing their own.
 */
export function getPilotDeckGateway() {
    return ensureGateway();
}

export function getPilotDeckRepoRoot() {
    return REPO_ROOT;
}

/**
 * Per-session state owned by the bridge. The frontend addresses sessions
 * by their PilotDeck `sessionKey` directly — no oldSessionId / newSessionId
 * indirection. The transcript on disk is named after this same key so
 * `/api/sessions/<sessionKey>/messages` can read it after a refresh.
 */
const sessionState = new Map();

function isPilotDeckSessionKey(value) {
    return typeof value === 'string' && /^web:s_/.test(value);
}

function newSessionKey() {
    return `web:s_${randomUUID()}`;
}

function ensureSessionState(sessionKey, projectKey, channelKey) {
    let state = sessionState.get(sessionKey);
    if (!state) {
        state = {
            sessionKey,
            projectKey,
            channelKey,
            runId: undefined,
            active: false,
            // Live array references — we mutate them in place when the
            // user adds tools so the agent's PermissionContext (which
            // captures the same references at session-creation time)
            // sees the update without recreating the session.
            permissionRules: { allow: [], deny: [], ask: [] },
        };
        sessionState.set(sessionKey, state);
    } else {
        // Refresh project/channel in case they changed (project switch).
        state.projectKey = projectKey;
        state.channelKey = channelKey;
    }
    return state;
}

/**
 * Translate the legacy frontend's `toolsSettings.allowedTools[]` /
 * `disallowedTools[]` into PilotDeck PermissionRule[]. We mutate the
 * existing arrays in place (don't replace them) so the live reference
 * captured by `createDefaultPermissionContext` reflects the update.
 */
function syncPermissionRules(state, toolsSettings) {
    const desiredAllow = Array.isArray(toolsSettings?.allowedTools)
        ? toolsSettings.allowedTools.filter((name) => typeof name === 'string' && name.length > 0)
        : [];
    const desiredDeny = Array.isArray(toolsSettings?.disallowedTools)
        ? toolsSettings.disallowedTools.filter((name) => typeof name === 'string' && name.length > 0)
        : [];

    state.permissionRules.allow.length = 0;
    for (const name of desiredAllow) {
        state.permissionRules.allow.push({
            source: 'session',
            behavior: 'allow',
            toolName: name,
        });
    }
    state.permissionRules.deny.length = 0;
    for (const name of desiredDeny) {
        state.permissionRules.deny.push({
            source: 'session',
            behavior: 'deny',
            toolName: name,
        });
    }
}

/**
 * Resolve the desired PermissionMode for a turn:
 * 1. Explicit `permissionMode` from the chat composer (mode dropdown).
 * 2. `toolsSettings.skipPermissions === true` (legacy "skip permissions"
 *    toggle) → bypassPermissions.
 * 3. `WEB_DEFAULT_PERMISSION_MODE` (default `default`).
 */
function resolvePermissionMode(options) {
    const explicit = options?.permissionMode || options?.mode;
    if (explicit) return explicit;
    if (options?.toolsSettings?.skipPermissions === true) {
        return 'bypassPermissions';
    }
    return WEB_DEFAULT_PERMISSION_MODE;
}

/**
 * Map a `GatewayEvent` to one or more legacy `NormalizedMessage` frames.
 *
 * @param {object} event Gateway event payload.
 * @param {string} sessionId UI-facing session id.
 * @param {string} provider Provider hint (claude/cursor/codex/gemini/pilotdeck).
 * @returns {object[]} NormalizedMessage frames.
 */
function gatewayEventToFrames(event, sessionId, provider) {
    const base = { sessionId, provider };
    switch (event.type) {
        case 'turn_started':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: 'started',
                }),
            ];
        case 'assistant_text_delta':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'stream_delta',
                    content: event.text,
                }),
            ];
        case 'assistant_thinking_delta':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'thinking',
                    content: event.text,
                }),
            ];
        case 'tool_call_started':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'tool_use',
                    toolId: event.toolCallId,
                    toolName: event.name,
                    toolInput: tryParseJson(event.argsPreview),
                }),
            ];
        case 'tool_call_finished':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'tool_result',
                    toolId: event.toolCallId,
                    content: event.resultPreview ?? '',
                    isError: !event.ok,
                }),
            ];
        case 'permission_request':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'permission_request',
                    requestId: event.requestId,
                    toolName: event.toolName,
                    input: event.payload,
                    context: { provider },
                }),
            ];
        case 'elicitation_request':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'interactive_prompt',
                    content: event.questions
                        ?.map((q) => q.prompt)
                        .filter(Boolean)
                        .join('\n') ?? '',
                    requestId: event.requestId,
                    toolCallId: event.toolCallId,
                    toolName: event.toolName,
                    questions: event.questions,
                    metadata: event.metadata,
                }),
            ];
        case 'elicitation_cancelled':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'permission_cancelled',
                    requestId: event.requestId,
                }),
            ];
        case 'structured_output':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: 'structured',
                    payload: event.payload,
                }),
            ];
        case 'plan_mode_changed':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'status',
                    text: `mode:${event.mode}`,
                }),
            ];
        case 'turn_completed':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'complete',
                    exitCode: 0,
                    success: true,
                    finishReason: event.finishReason,
                    usage: event.usage,
                }),
            ];
        case 'error':
            return [
                createNormalizedMessage({
                    ...base,
                    kind: 'error',
                    content: event.message,
                    code: event.code,
                    recoverable: event.recoverable,
                }),
            ];
        default:
            return [];
    }
}

function tryParseJson(value) {
    if (typeof value !== 'string' || !value) return undefined;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/**
 * Run a chat command through the PilotDeck gateway.
 *
 * The frontend addresses sessions by the PilotDeck `sessionKey` itself
 * (`web:s_<uuid>`). On the first turn we mint a key and announce it via
 * a `session_created` frame; the frontend stores that and uses it on
 * every subsequent turn (and after page refresh, since the URL embeds
 * it). The transcript on disk is named after the same key, so
 * `/api/sessions/<sessionKey>/messages` resolves cleanly.
 *
 * `options.toolsSettings` is mapped to per-session PermissionRule[] via
 * `SessionConfigOverrides` — clicking "Permission added" in the UI
 * pushes the tool name into that allow list and the next turn picks it
 * up because the rule arrays are shared by reference with the agent's
 * `PermissionContext`.
 *
 * @param {string} command User prompt text.
 * @param {object} options Legacy options blob from the WS frame.
 * @param {{send: (msg: object) => void}} writer Existing writer.
 * @param {string} provider Provider hint (kept for legacy frame branding).
 */
export async function runChatViaGateway(command, options = {}, writer, provider = 'pilotdeck') {
    const gw = ensureGateway();
    const projectKey = options.projectPath || options.cwd || REPO_ROOT;
    const channelKey = 'web';

    // Resolve / mint the sessionKey. We accept any incoming PilotDeck-
    // shaped key as-is; anything else (legacy uuid from old transcripts,
    // missing field, etc.) gets a fresh key and a session_created frame.
    const incoming = options.sessionId || options.sessionKey;
    let sessionKey = isPilotDeckSessionKey(incoming) ? incoming : newSessionKey();
    const isNewSession = sessionKey !== incoming;

    const state = ensureSessionState(sessionKey, projectKey, channelKey);

    // Sync per-session permission rules before the override is consumed
    // by `createSession`. We mutate the same array references that the
    // PermissionContext captures, so updates from a prior "Permission
    // added" click apply on the very next turn without recreating the
    // session.
    syncPermissionRules(state, options.toolsSettings);
    sessionOverrides.set(sessionKey, {
        cwd: projectKey,
        permissionMode: resolvePermissionMode(options),
        bypassAvailable: true,
        canPrompt: false,
        permissionRules: state.permissionRules,
    });

    if (isNewSession) {
        writer.send(
            createNormalizedMessage({
                provider,
                sessionId: sessionKey,
                kind: 'session_created',
                newSessionId: sessionKey,
                sessionKey,
            }),
        );
    }

    const runId = randomUUID();
    state.runId = runId;
    state.active = true;

    try {
        const stream = gw.submitTurn({
            sessionKey,
            channelKey,
            projectKey,
            message: command ?? '',
            mode: options?.permissionMode || options?.mode,
            runId,
        });
        for await (const event of stream) {
            if (event && event.type === 'error') {
                console.error(
                    '[pilotdeck-bridge] gateway error event:',
                    JSON.stringify(
                        {
                            sessionKey,
                            projectKey,
                            runId,
                            code: event.code,
                            message: event.message,
                            recoverable: event.recoverable,
                        },
                        null,
                        2,
                    ),
                );
            }
            for (const frame of gatewayEventToFrames(event, sessionKey, provider)) {
                writer.send(frame);
            }
        }
        writer.send(
            createNormalizedMessage({
                provider,
                sessionId: sessionKey,
                kind: 'complete',
                exitCode: 0,
                success: true,
            }),
        );
    } catch (error) {
        console.error(
            '[pilotdeck-bridge] runChatViaGateway threw:',
            error instanceof Error ? (error.stack || error.message) : error,
        );
        writer.send(
            createNormalizedMessage({
                provider,
                sessionId: sessionKey,
                kind: 'error',
                content: error instanceof Error ? error.message : String(error),
            }),
        );
    } finally {
        state.active = false;
        state.runId = undefined;
    }
}

export async function abortViaGateway(sessionId, _provider = 'pilotdeck') {
    const gw = ensureGateway();
    const sessionKey = isPilotDeckSessionKey(sessionId) ? sessionId : null;
    if (!sessionKey) return false;
    const state = sessionState.get(sessionKey);
    try {
        await gw.abortTurn({ sessionKey, runId: state?.runId });
        return true;
    } catch (error) {
        console.warn('[pilotdeck-bridge] abortTurn failed:', error);
        return false;
    }
}

export async function decidePermissionViaGateway(requestId, decision, options = {}) {
    const gw = ensureGateway();
    // PermissionBus is keyed by sessionKey + requestId. We don't know
    // which session owns the request, so try each known session.
    for (const state of sessionState.values()) {
        try {
            const result = await gw.permissionDecide({
                sessionKey: state.sessionKey,
                requestId,
                decision: decision === 'allow' || decision === true ? 'allow' : 'deny',
                remember: options.remember,
                reason: options.reason,
            });
            if (result?.delivered) return true;
        } catch (error) {
            console.warn('[pilotdeck-bridge] permissionDecide failed:', error);
        }
    }
    return false;
}

export function isSessionActiveViaGateway(sessionId) {
    if (!isPilotDeckSessionKey(sessionId)) return false;
    return Boolean(sessionState.get(sessionId)?.active);
}

export function getActiveSessionIdsViaGateway() {
    return [...sessionState.values()]
        .filter((state) => state.active)
        .map((state) => state.sessionKey);
}

/**
 * Build a `DashboardData` payload from the per-project RouterRuntime
 * stats collected by `src/router/stats/TokenStatsCollector`. Shape
 * mirrors what `ui/src/hooks/useRoutingDashboard.ts` expects so the V2
 * Dashboard tab renders without changing any frontend code.
 */
export function getRouterDashboardData() {
    const gw = ensureGateway();
    const statsByProject = getLocalGatewayRouterStats(gw) || new Map();

    const projects = [];
    const overall = makeBucket();
    const overallByTier = {};
    const overallByRole = {};
    let overallSessionCount = 0;

    for (const [projectKey, snapshot] of statsByProject.entries()) {
        const records = Array.isArray(snapshot.records) ? snapshot.records : [];
        const sessionMap = new Map();
        for (const record of records) {
            let sessionEntry = sessionMap.get(record.sessionId);
            if (!sessionEntry) {
                sessionEntry = {
                    sessionId: record.sessionId,
                    title: record.sessionId,
                    provider: record.provider || 'pilotdeck',
                    lastActivity: record.endedAt,
                    routing: {
                        total: makeBucket(),
                        byTier: {},
                        byScenario: {},
                        byRole: {},
                        byModel: {},
                        firstSeenAt: Date.parse(record.startedAt) || 0,
                        lastActiveAt: Date.parse(record.endedAt) || 0,
                    },
                };
                sessionMap.set(record.sessionId, sessionEntry);
            }
            mergeRecordIntoSession(sessionEntry.routing, record);
            const ended = Date.parse(record.endedAt) || 0;
            if (ended > (sessionEntry.routing.lastActiveAt || 0)) {
                sessionEntry.routing.lastActiveAt = ended;
                sessionEntry.lastActivity = record.endedAt;
            }
        }

        const sessions = [...sessionMap.values()];
        const aggregated = {
            total: makeBucket(),
            byTier: {},
            byRole: {},
            sessionCount: sessions.length,
            routedSessionCount: sessions.length,
        };
        for (const session of sessions) {
            addBuckets(aggregated.total, session.routing.total);
            for (const [tier, bucket] of Object.entries(session.routing.byTier)) {
                aggregated.byTier[tier] = aggregated.byTier[tier] || makeBucket();
                addBuckets(aggregated.byTier[tier], bucket);
            }
            for (const [role, bucket] of Object.entries(session.routing.byRole)) {
                aggregated.byRole[role] = aggregated.byRole[role] || makeBucket();
                addBuckets(aggregated.byRole[role], bucket);
            }
        }

        addBuckets(overall, aggregated.total);
        for (const [tier, bucket] of Object.entries(aggregated.byTier)) {
            overallByTier[tier] = overallByTier[tier] || makeBucket();
            addBuckets(overallByTier[tier], bucket);
        }
        for (const [role, bucket] of Object.entries(aggregated.byRole)) {
            overallByRole[role] = overallByRole[role] || makeBucket();
            addBuckets(overallByRole[role], bucket);
        }
        overallSessionCount += sessions.length;

        projects.push({
            name: deriveProjectName(projectKey),
            displayName: deriveProjectDisplayName(projectKey),
            fullPath: projectKey,
            sessions,
            aggregated,
        });
    }

    return {
        projects,
        overall: {
            total: overall,
            byTier: overallByTier,
            byRole: overallByRole,
            projectCount: projects.length,
            sessionCount: overallSessionCount,
        },
        unmatchedSessions: [],
    };
}

function makeBucket() {
    return {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        requestCount: 0,
        estimatedCost: 0,
    };
}

function addBuckets(target, source) {
    target.inputTokens += source.inputTokens || 0;
    target.outputTokens += source.outputTokens || 0;
    target.cacheReadTokens += source.cacheReadTokens || 0;
    target.totalTokens += source.totalTokens || 0;
    target.requestCount += source.requestCount || 0;
    target.estimatedCost += source.estimatedCost || 0;
}

function mergeRecordIntoSession(routing, record) {
    const usage = record.usage || {};
    const bucket = {
        inputTokens: usage.inputTokens || 0,
        outputTokens: usage.outputTokens || 0,
        cacheReadTokens: usage.cacheReadTokens || 0,
        totalTokens:
            usage.totalTokens ??
            (usage.inputTokens || 0) + (usage.outputTokens || 0),
        requestCount: 1,
        estimatedCost: 0,
    };
    addBuckets(routing.total, bucket);

    const tierKey = record.scenarioType || 'default';
    routing.byTier[tierKey] = routing.byTier[tierKey] || makeBucket();
    addBuckets(routing.byTier[tierKey], bucket);

    const scenarioKey = record.scenarioType || 'default';
    routing.byScenario[scenarioKey] = routing.byScenario[scenarioKey] || makeBucket();
    addBuckets(routing.byScenario[scenarioKey], bucket);

    const roleKey = record.resolvedFrom === 'subagent' ? 'sub' : 'main';
    routing.byRole[roleKey] = routing.byRole[roleKey] || makeBucket();
    addBuckets(routing.byRole[roleKey], bucket);

    const modelKey = `${record.provider || 'unknown'}/${record.model || 'unknown'}`;
    routing.byModel[modelKey] = routing.byModel[modelKey] || makeBucket();
    addBuckets(routing.byModel[modelKey], bucket);
}

function deriveProjectName(projectKey) {
    return projectKey
        .replace(/^\/+/, '')
        .replace(/[^A-Za-z0-9._-]+/g, '-');
}

function deriveProjectDisplayName(projectKey) {
    const parts = projectKey.split('/').filter(Boolean);
    return parts.length > 0 ? parts[parts.length - 1] : projectKey;
}

/**
 * Per-session stats payload for `/api/ccr/stats/sessions/:id`. Returns
 * `null` when no router activity has been observed for the session yet.
 */
export function getRouterSessionStats(sessionId) {
    const dashboard = getRouterDashboardData();
    for (const project of dashboard.projects) {
        const session = project.sessions.find((s) => s.sessionId === sessionId);
        if (session) {
            return {
                sessionId,
                projectName: project.name,
                routing: session.routing,
            };
        }
    }
    return null;
}

/**
 * Lifetime aggregate suitable for `/api/ccr/stats/summary`.
 */
export function getRouterStatsSummary() {
    const data = getRouterDashboardData();
    const byScenario = {};
    const byProvider = {};
    const byTier = data.overall.byTier;
    for (const project of data.projects) {
        for (const session of project.sessions) {
            for (const [scenario, bucket] of Object.entries(session.routing.byScenario)) {
                byScenario[scenario] = byScenario[scenario] || makeBucket();
                addBuckets(byScenario[scenario], bucket);
            }
            for (const [model, bucket] of Object.entries(session.routing.byModel)) {
                const provider = model.includes('/') ? model.split('/', 1)[0] : model;
                byProvider[provider] = byProvider[provider] || makeBucket();
                addBuckets(byProvider[provider], bucket);
            }
        }
    }
    return {
        lifetime: {
            total: data.overall.total,
            byScenario,
            byProvider,
            byTier,
        },
        lastUpdatedAt: new Date().toISOString(),
    };
}

export async function elicitationRespondViaGateway(requestId, answer) {
    const gw = ensureGateway();
    for (const state of sessionState.values()) {
        try {
            const result = await gw.respondElicitation({
                sessionKey: state.sessionKey,
                requestId,
                answer,
            });
            if (result?.delivered) return true;
        } catch (error) {
            console.warn('[pilotdeck-bridge] respondElicitation failed:', error);
        }
    }
    return false;
}
