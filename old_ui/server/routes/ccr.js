/**
 * CCR (Claude Code Router) API routes — zero-port mode.
 *
 * Directly calls CCR services in-process instead of proxying HTTP.
 * Exposes stats, health, config CRUD, and dashboard endpoints.
 */

import { Router } from 'express';
import {
  getCCRBaseUrl,
  getCCRModule,
  getCCRServices,
  getCCRInstance,
  loadCCRConfig,
  saveCCRConfig,
  restartCCR,
} from '../embedded-ccr.js';
import { resolveClaudeCodeMainRoot } from '../claude-code-main-path.js';
import { getProjects } from '../projects.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const router = Router();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getCollector() {
  const mod = getCCRModule();
  if (!mod?.getGlobalStatsCollector) return null;
  return mod.getGlobalStatsCollector();
}

function maskApiKey(key) {
  if (!key || typeof key !== 'string' || key.length < 12) return key;
  return key.slice(0, 6) + '****' + key.slice(-4);
}

function sanitizeConfigForClient(config) {
  if (!config) return config;
  const clone = JSON.parse(JSON.stringify(config));
  if (Array.isArray(clone.Providers)) {
    for (const p of clone.Providers) {
      if (p.api_key) p.api_key = maskApiKey(p.api_key);
    }
  }
  return clone;
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

router.get('/health', (_req, res) => {
  const services = getCCRServices();
  if (!services) {
    return res.status(503).json({ error: 'CCR not running', embedded: false });
  }
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    port: null,
    embedded: true,
    zeroPort: true,
  });
});

// ---------------------------------------------------------------------------
// Stats — direct service calls (no HTTP proxy)
// ---------------------------------------------------------------------------

router.get('/stats/summary', (_req, res) => {
  const collector = getCollector();
  if (!collector) return res.json({ error: 'Token stats not enabled' });
  res.json(collector.getSummary());
});

router.get('/stats/sessions', (_req, res) => {
  const collector = getCollector();
  if (!collector) return res.json({ error: 'Token stats not enabled' });
  res.json(collector.getSessionStats());
});

router.get('/stats/sessions/:sessionId', (req, res) => {
  const collector = getCollector();
  if (!collector) return res.status(503).json({ error: 'Token stats not enabled' });

  const sessions = collector.getSessionStats();
  const all = Array.isArray(sessions) ? sessions : [];
  const match = all.find((s) => s.sessionId === req.params.sessionId);
  if (!match) return res.status(404).json({ error: 'Session not found in CCR stats' });
  res.json(match);
});

router.get('/stats/hourly', (_req, res) => {
  const collector = getCollector();
  if (!collector) return res.json({ error: 'Token stats not enabled' });
  res.json(collector.getHourly());
});

router.post('/stats/reset', async (_req, res) => {
  const collector = getCollector();
  if (!collector) return res.json({ error: 'Token stats not enabled' });
  await collector.reset();
  res.json({ message: 'Stats reset successfully' });
});

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

router.get('/config', (_req, res) => {
  try {
    const ccrRoot = resolveClaudeCodeMainRoot();
    const config = loadCCRConfig(ccrRoot);
    if (!config) return res.status(404).json({ error: 'Router not enabled — set router.enabled: true in ~/.edgeclaw/config.yaml' });
    res.json(sanitizeConfigForClient(config));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/config', async (req, res) => {
  try {
    const incoming = req.body;
    if (!incoming || typeof incoming !== 'object') {
      return res.status(400).json({ error: 'Invalid config body' });
    }

    const ccrRoot = resolveClaudeCodeMainRoot();
    const existing = loadCCRConfig(ccrRoot);

    if (existing && Array.isArray(incoming.Providers) && Array.isArray(existing.Providers)) {
      for (const provider of incoming.Providers) {
        if (provider.api_key && provider.api_key.includes('****')) {
          const orig = existing.Providers.find((p) => p.name === provider.name);
          if (orig) provider.api_key = orig.api_key;
        }
      }
    }

    saveCCRConfig(incoming);

    try {
      const result = await restartCCR();
      res.json({ success: true, restarted: true, zeroPort: true });
    } catch (restartErr) {
      res.json({ success: true, restarted: false, restartError: restartErr.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Dashboard — cross-references projects with CCR session stats
// ---------------------------------------------------------------------------

function extractPlainQuery(raw) {
  if (!raw || !raw.startsWith('{')) return raw || '';
  try {
    const obj = JSON.parse(raw);
    return obj.query || obj.focus_user_turn?.content || raw;
  } catch { /* JSON may be truncated */ }
  // Regex fallback for truncated JSON — content may not have closing quote
  const m = raw.match(/"(?:query|content)":\s*"([^"]{2,})/);
  if (m) return m[1].replace(/["}\]\\,\s]+$/, '').replace(/…$/, '');
  return raw;
}

async function extractUserQueries(projectName, sessionId, limit = 20) {
  try {
    const sessionPath = join(homedir(), '.claude', 'projects', projectName, `${sessionId}.jsonl`);
    const raw = await readFile(sessionPath, 'utf-8');
    const queries = [];
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.message?.role !== 'user') continue;
        let text = entry.message.content;
        if (Array.isArray(text) && text.length > 0 && text[0].type === 'text') text = text[0].text;
        if (typeof text !== 'string' || !text || text.startsWith('<') || text.startsWith('{')) continue;
        if (text === 'Warmup' || text.startsWith('Caveat:') || text.startsWith('This session is being continued')) continue;
        queries.push(text.length > 120 ? text.slice(0, 120) + '…' : text);
        if (queries.length >= limit) break;
      } catch { /* skip malformed lines */ }
    }
    return queries;
  } catch {
    return [];
  }
}

function emptyBucket() {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, requestCount: 0, estimatedCost: 0 };
}

function mergeBuckets(target, source) {
  target.inputTokens += source.inputTokens || 0;
  target.outputTokens += source.outputTokens || 0;
  target.cacheReadTokens += source.cacheReadTokens || 0;
  target.totalTokens += source.totalTokens || 0;
  target.requestCount += source.requestCount || 0;
  target.estimatedCost += source.estimatedCost || 0;
}

function mergeRecordBuckets(target, source) {
  for (const [key, bucket] of Object.entries(source || {})) {
    if (!target[key]) target[key] = emptyBucket();
    mergeBuckets(target[key], bucket);
  }
}

router.get('/dashboard', async (_req, res) => {
  try {
    // Prefer live stats from proxy subprocess over in-process collector
    let allSessions = [];
    const proxyPort = process.env.PROXY_PORT || process.env.EDGECLAW_PROXY_PORT || '18080';
    try {
      const resp = await fetch(`http://127.0.0.1:${proxyPort}/ccr-stats/sessions`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const data = await resp.json();
        if (Array.isArray(data) && data.length > 0) allSessions = data;
      }
    } catch { /* proxy unreachable, fall through to in-process collector */ }

    if (allSessions.length === 0) {
      const collector = getCollector();
      const ccrSessions = collector ? collector.getSessionStats() : [];
      allSessions = Array.isArray(ccrSessions) ? ccrSessions : [];
    }

    const projectsData = await getProjects().catch(() => []);

    // Build lookup map: exact sessionId → stats, plus suffix-based fallback
    // CCR stores sessionId as extracted from metadata.user_id's session_id field.
    // UI sessions use IDs like "abc-123" which should match directly.
    const ccrMap = new Map();
    const ccrSuffixMap = new Map();
    for (const s of allSessions) {
      ccrMap.set(s.sessionId, s);
      // Also index by last segment after underscore for legacy format matching
      const parts = (s.sessionId || '').split('_session_');
      if (parts.length > 1) ccrSuffixMap.set(parts[1], s);
    }

    function findCcrStats(uiSessionId) {
      return ccrMap.get(uiSessionId) || ccrSuffixMap.get(uiSessionId) || null;
    }

    const matchedCcrIds = new Set();
    const overall = {
      total: emptyBucket(),
      byTier: {},
      byRole: {},
      projectCount: 0,
      sessionCount: 0,
    };

    const projects = [];

    for (const proj of projectsData) {
      const projSessions = [
        ...(proj.sessions || []).map((s) => ({ ...s, __provider: s.__provider || 'claude' })),
        ...(proj.cursorSessions || []).map((s) => ({ ...s, __provider: 'cursor' })),
        ...(proj.codexSessions || []).map((s) => ({ ...s, __provider: 'codex' })),
        ...(proj.geminiSessions || []).map((s) => ({ ...s, __provider: 'gemini' })),
      ];

      const aggregated = {
        total: emptyBucket(),
        byTier: {},
        byRole: {},
        sessionCount: projSessions.length,
        routedSessionCount: 0,
      };

      const sessions = await Promise.all(projSessions.map(async (s) => {
        const sid = s.id;
        const ccrStats = findCcrStats(sid);
        if (ccrStats) {
          matchedCcrIds.add(ccrStats.sessionId);
          aggregated.routedSessionCount++;
          mergeBuckets(aggregated.total, ccrStats.total || {});
          mergeRecordBuckets(aggregated.byTier, ccrStats.byTier);
          mergeRecordBuckets(aggregated.byRole, ccrStats.byRole);
        }

        const userQueries = await extractUserQueries(proj.name, sid);

        return {
          sessionId: sid,
          title: s.summary || s.title || s.name || s.lastUserMessage || '',
          provider: s.__provider || 'claude',
          lastActivity: s.lastActivity || s.updated_at || s.createdAt || null,
          userQueries,
          routing: ccrStats
            ? {
                total: ccrStats.total,
                byTier: ccrStats.byTier || {},
                byScenario: ccrStats.byScenario || {},
                byRole: ccrStats.byRole || {},
                byModel: ccrStats.byModel || {},
                requestLog: ccrStats.requestLog || [],
                firstSeenAt: ccrStats.firstSeenAt,
                lastActiveAt: ccrStats.lastActiveAt,
              }
            : null,
        };
      }));

      mergeBuckets(overall.total, aggregated.total);
      mergeRecordBuckets(overall.byTier, aggregated.byTier);
      mergeRecordBuckets(overall.byRole, aggregated.byRole);
      overall.sessionCount += aggregated.sessionCount;

      projects.push({
        name: proj.name,
        displayName: proj.displayName || proj.name,
        fullPath: proj.fullPath || proj.path || '',
        sessions,
        aggregated,
      });
    }

    overall.projectCount = projects.length;

    const unmatchedSessions = allSessions.filter((s) => !matchedCcrIds.has(s.sessionId));

    // Merge unmatched sessions into the "general" project
    let generalProject = projects.find((p) => p.displayName === 'general' || p.name === 'general');
    if (!generalProject) {
      generalProject = {
        name: 'general',
        displayName: 'general',
        fullPath: '',
        sessions: [],
        aggregated: { total: emptyBucket(), byTier: {}, byRole: {}, sessionCount: 0, routedSessionCount: 0 },
      };
      projects.push(generalProject);
      overall.projectCount = projects.length;
    }

    for (const s of unmatchedSessions) {
      mergeBuckets(overall.total, s.total || {});
      mergeRecordBuckets(overall.byTier, s.byTier);
      mergeRecordBuckets(overall.byRole, s.byRole);

      mergeBuckets(generalProject.aggregated.total, s.total || {});
      mergeRecordBuckets(generalProject.aggregated.byTier, s.byTier);
      mergeRecordBuckets(generalProject.aggregated.byRole, s.byRole);
      generalProject.aggregated.sessionCount++;
      if (s.total && s.total.requestCount > 0) generalProject.aggregated.routedSessionCount++;

      let unmatchedTitle = s.sessionId;
      const firstQuery = s.requestLog?.[0]?.query;
      if (firstQuery) {
        unmatchedTitle = extractPlainQuery(firstQuery);
        if (unmatchedTitle.length > 80) unmatchedTitle = unmatchedTitle.slice(0, 80) + '…';
      }

      generalProject.sessions.push({
        sessionId: s.sessionId,
        title: unmatchedTitle,
        provider: 'router',
        lastActivity: s.lastActiveAt ? new Date(s.lastActiveAt).toISOString() : null,
        userQueries: (s.requestLog || []).filter((e) => e.role === 'main').map((e) => e.query ? extractPlainQuery(e.query) : null).filter(Boolean),
        routing: {
          total: s.total,
          byTier: s.byTier || {},
          byScenario: s.byScenario || {},
          byRole: s.byRole || {},
          byModel: s.byModel || {},
          requestLog: s.requestLog || [],
          firstSeenAt: s.firstSeenAt,
          lastActiveAt: s.lastActiveAt,
        },
      });
    }

    overall.sessionCount += unmatchedSessions.length;

    res.json({ projects, overall, unmatchedSessions: [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
