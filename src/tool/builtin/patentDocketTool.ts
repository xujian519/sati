import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  abandonDocket,
  archiveRevision,
  CASE_ROOT_REL,
  createDocket,
  DocketError,
  finalizeDocket,
  JsonFileDocketStore,
  recordRevision,
  setGapQuestions,
  triageDocket,
  type DocketState,
  type DocketStore,
} from "../../patent/index.js";
import type { SatiJsonSchema } from "../protocol/schema.js";
import type { SatiToolDefinition } from "../protocol/types.js";

/**
 * `patent_docket` — 案卷轮次工具（P0-1 案卷级迭代循环）。
 *
 * 接线 src/patent/docket 状态机：create 立案（缺口清单可同步登记）→ set_gaps
 * 维护缺口 → triage 分诊派工（draft / revise 第 N 轮 / finalize_ready /
 * escalate_human）→ record_revision 记一轮修订（轮次上限强制，answered 匹配的
 * 缺口置 resolved，阶段产物经 archiveRevision 另存 revisions/round-N/ 留档，
 * 旧稿不动）→ finalize 定稿（未决缺口 fail-closed）/ abandon 放弃（原因审计）。
 *
 * 阶段执行本身走 flexible_plan 工具（run/confirm/rollback）；rollback 后重新
 * run 成功即"新一轮修订"的触发点，本工具只管案卷状态与轮次强制。案卷按 caseId
 * 持久化（<caseDir>/dockets/，与 workflow-runs 同域约定）。
 */

export type DocketAction =
  | "create"
  | "get"
  | "list"
  | "set_gaps"
  | "triage"
  | "record_revision"
  | "finalize"
  | "abandon";

export type DocketGapInput = {
  id: string;
  question: string;
  source?: string;
};

export type PatentDocketToolInput = {
  action: DocketAction;
  /** 案卷主键（除 list/create 外必需；持久化按此键控）。 */
  caseId?: string;
  /** 对齐 orchestrations id（create 必需）。 */
  caseType?: string;
  /** 修订轮次上限（create 可选，默认 3）。 */
  maxRounds?: number;
  /** 关联 flexible_plan 计划 caseId（create 可选，缺省同案卷 id）。 */
  linkedPlanCaseId?: string;
  /** 案件备注/定稿备注（create / finalize）。 */
  notes?: string;
  /** 缺口问题清单（create / set_gaps）。 */
  gaps?: DocketGapInput[];
  /** 本轮回答的缺口（record_revision：缺口 id 或问题原文）。 */
  answered?: string[];
  /** 本轮归档的阶段产物（record_revision：{name, path}，path 相对 cwd 读文件）。 */
  artifacts?: Array<{ name: string; path: string }>;
  /** 放弃原因（abandon 必需，审计留痕）。 */
  reason?: string;
};

export type PatentDocketToolDeps = {
  /** 案卷存储（缺省 JsonFileDocketStore：<caseDir>/dockets/）。 */
  store?: DocketStore;
  /** 可注入时钟（测试用）。 */
  now?: () => string;
};

const GAP_SCHEMA: SatiJsonSchema = {
  type: "object",
  required: ["id", "question"],
  additionalProperties: false,
  properties: {
    id: { type: "string", description: "Gap key, unique within the docket." },
    question: { type: "string", description: "The open question / missing fact." },
    source: { type: "string", description: "Where the gap came from (search / OA / disclosure)." },
  },
};

function renderDocket(docket: DocketState): string {
  const lines: string[] = [
    `patent_docket(caseId=${docket.caseId}, caseType=${docket.caseType}, phase=${docket.phase})`,
    `轮次: ${docket.round}/${docket.maxRounds}${docket.linkedPlanCaseId !== undefined ? ` · 计划: ${docket.linkedPlanCaseId}` : ""}`,
  ];
  if (docket.notes !== undefined) lines.push(`备注: ${docket.notes}`);
  const open = docket.gaps.filter(g => !g.resolved);
  const closed = docket.gaps.filter(g => g.resolved);
  if (open.length > 0) {
    lines.push(`未决缺口 (${open.length}):`, ...open.map(g => `- ⏳ ${g.id}: ${g.question}`));
  }
  if (closed.length > 0) {
    lines.push(`已解决缺口 (${closed.length}):`, ...closed.map(g => `- ✅ ${g.id}（第 ${g.resolvedRound ?? "?"} 轮）`));
  }
  if (docket.revisions.length > 0) {
    lines.push(
      `修订记录:`,
      ...docket.revisions.map(r => `- 第 ${r.round} 轮: 回答 ${r.answered.join(", ")}（${r.at}）`),
    );
  }
  if (docket.abandonReason !== undefined) lines.push(`放弃原因: ${docket.abandonReason}`);
  return lines.join("\n");
}

function renderTriage(next: ReturnType<typeof triageDocket>["next"]): string {
  switch (next.kind) {
    case "draft":
      return "分诊 → draft：案卷刚建立、尚无缺口登记。先用 flexible_plan 起草执行，再经 set_gaps 登记缺口。";
    case "finalize_ready":
      return "分诊 → finalize_ready：缺口已全部解决，可执行 finalize 定稿。";
    case "revise": {
      const items = next.openGaps.map(g => `  - ${g.id}: ${g.question}`).join("\n");
      return `分诊 → revise（第 ${next.round} 轮）：派工修订，回答以下缺口后用 record_revision 记账：\n${items}`;
    }
    case "escalate_human": {
      const items = next.openGaps.map(g => `  - ${g.id}: ${g.question}`).join("\n");
      return `分诊 → escalate_human：修订轮次已达上限，仍有 ${next.openGaps.length} 个未决缺口，请升级人工处理（不得继续自动修订）：\n${items}`;
    }
  }
}

async function loadDocket(store: DocketStore, caseId: string): Promise<DocketState> {
  const docket = await store.loadDocket(caseId);
  if (docket === undefined) throw new DocketError(`案卷 "${caseId}" 不存在（先用 action=create 立案）`);
  return docket;
}

/**
 * 案卷目录解析：单一根 `<cwd>/data/cases/dockets`（与 workflow 案例区同级）。
 * caseId 经 SAFE_ID_PATTERN 约束不含路径分隔符，故不需多态解析；
 * 案卷 JSON（<caseId>.json）与 revisions/ 归档同居该根，list 能扫到全部案卷。
 */
function resolveDocketDir(cwd: string): string {
  return join(cwd, CASE_ROOT_REL, "dockets");
}

/** 缺省存储：JsonFileDocketStore（<cwd>/data/cases/dockets/）。 */
function defaultDocketStore(cwd: string): DocketStore {
  return new JsonFileDocketStore(resolveDocketDir(cwd));
}

function toolText(message: string): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: message }] };
}

export function createPatentDocketTool(deps: PatentDocketToolDeps = {}): SatiToolDefinition<PatentDocketToolInput> {
  return {
    name: "patent_docket",
    outputSchema: {
      type: "object",
      properties: {},
    },
    aliases: ["PatentDocket", "docket"],
    description:
      "Case-file (docket) round control for patent cases: create a docket (optional initial gap list), " +
      "maintain gap questions (set_gaps), triage the file into the next action (draft / revise round N / " +
      "finalize_ready / escalate_human once the round cap is hit), record revisions with mandatory " +
      "version archiving (revisions/round-N/, old drafts untouched — answers must map to open gaps), " +
      "finalize (refuses while open gaps remain) or abandon with a reason. Stage execution itself stays " +
      "in flexible_plan; this tool enforces the " +
      "gap-list → dispatch → capped-revision-loop → finalize-gate rhythm of real patent prosecution.",
    kind: "session",
    domain: "patent",
    inputSchema: {
      type: "object",
      required: ["action"],
      additionalProperties: false,
      properties: {
        action: {
          type: "string",
          enum: ["create", "get", "list", "set_gaps", "triage", "record_revision", "finalize", "abandon"],
          description: "Operation: create | get | list | set_gaps | triage | record_revision | finalize | abandon.",
        },
        caseId: { type: "string", description: "Docket key (required except list; persists by this id)." },
        caseType: {
          type: "string",
          description: "Orchestration type, e.g. invalidation / infringement / drafting (create).",
        },
        maxRounds: { type: "number", description: "Revision round cap for create (default 3)." },
        linkedPlanCaseId: {
          type: "string",
          description: "flexible_plan case id linked to this docket (create; defaults to caseId).",
        },
        notes: { type: "string", description: "Case note (create) or finalization note (finalize)." },
        gaps: {
          type: "array",
          description: "Gap questions (create / set_gaps; set_gaps merges by id and reopens matched gaps).",
          items: GAP_SCHEMA,
        },
        answered: {
          type: "array",
          items: { type: "string" },
          description: "Gap ids or verbatim question texts answered this round (record_revision).",
        },
        artifacts: {
          type: "array",
          description: "Stage artifacts to archive this round (record_revision; path relative to cwd).",
          items: {
            type: "object",
            required: ["name", "path"],
            additionalProperties: false,
            properties: {
              name: { type: "string" },
              path: { type: "string" },
            },
          },
        },
        reason: { type: "string", description: "Abandon reason, kept for audit (abandon)." },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    async execute(input, context) {
      const cwd = context?.cwd ?? process.cwd();
      try {
        if (input.action === "list") {
          const ids = await defaultDocketStore(cwd).listCaseIds();
          return toolText(
            ids.length > 0 ? `patent_docket 案卷 (${ids.length}): ${ids.join(", ")}` : "patent_docket: 暂无案卷。",
          );
        }
        if (input.caseId === undefined || input.caseId.trim() === "") {
          return toolText(`patent_docket: ${input.action} 需要 caseId（案卷按 caseId 持久化）`);
        }
        const docketDir = resolveDocketDir(cwd);
        const store = deps.store ?? new JsonFileDocketStore(docketDir);

        switch (input.action) {
          case "create": {
            if (input.caseType === undefined || input.caseType.trim() === "") {
              return toolText("patent_docket: create 需要 caseType");
            }
            const existing = await store.loadDocket(input.caseId);
            if (existing !== undefined) {
              return toolText(`patent_docket: 案卷 "${input.caseId}" 已存在\n${renderDocket(existing)}`);
            }
            const docket = createDocket(input.caseId, input.caseType, {
              ...(input.maxRounds !== undefined ? { maxRounds: input.maxRounds } : {}),
              ...(input.linkedPlanCaseId !== undefined ? { linkedPlanCaseId: input.linkedPlanCaseId } : {}),
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              gaps: input.gaps ?? [],
              ...(deps.now !== undefined ? { now: deps.now } : {}),
            });
            await store.saveDocket(docket);
            return toolText(`${renderDocket(docket)}\n已立案并持久化（action=triage 获取下一步派工）。`);
          }
          case "get": {
            const docket = await loadDocket(store, input.caseId);
            return toolText(renderDocket(docket));
          }
          case "set_gaps": {
            if (input.gaps === undefined || input.gaps.length === 0) {
              return toolText("patent_docket: set_gaps 需要 gaps（缺口清单）");
            }
            const docket = await loadDocket(store, input.caseId);
            const updated = setGapQuestions(docket, input.gaps);
            await store.saveDocket(updated);
            return toolText(`${renderDocket(updated)}\n已更新缺口清单（同 id 重开，未提到的保持原状态）。`);
          }
          case "triage": {
            const docket = await loadDocket(store, input.caseId);
            const { next } = triageDocket(docket);
            return toolText(`${renderDocket(docket)}\n${renderTriage(next)}`);
          }
          case "record_revision": {
            if (input.answered === undefined || input.answered.length === 0) {
              return toolText("patent_docket: record_revision 需要 answered（本轮回答的缺口 id 或原文）");
            }
            const docket = await loadDocket(store, input.caseId);
            const updated = recordRevision(docket, {
              answered: input.answered,
              ...(input.notes !== undefined ? { notes: input.notes } : {}),
              artifacts: (input.artifacts ?? []).map(a => a.name),
            });
            // 归档本轮产物（读文件失败不阻断记账：降级为 notes 提示，轮次事实已成立）。
            let archiveNote = "本轮无产物归档";
            if (input.artifacts !== undefined && input.artifacts.length > 0) {
              const loaded: Array<{ name: string; content: string }> = [];
              const missing: string[] = [];
              for (const a of input.artifacts) {
                // 产物读取限制在工作区内（对齐 read_file 的 workspace 守卫）：
                // 含 ../ 或绝对路径的越界项按「读失败不阻断记账」降级为 missing。
                const abs = resolve(cwd, a.path);
                const rel = relative(cwd, abs);
                if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
                  missing.push(a.name);
                  continue;
                }
                try {
                  loaded.push({ name: a.name, content: await readFile(abs, "utf8") });
                } catch {
                  // 产物读取失败（缺失/权限）不阻断记账：降级为归档提示。
                  missing.push(a.name);
                }
              }
              const revision = updated.revisions[updated.revisions.length - 1];
              if (revision !== undefined && loaded.length > 0) {
                const dir = await archiveRevision({
                  caseId: updated.caseId,
                  round: revision.round,
                  revision,
                  artifacts: loaded,
                  docketsDir: docketDir,
                });
                archiveNote = `产物已归档: ${dir}${missing.length > 0 ? `（读取失败未归档: ${missing.join(", ")}）` : ""}`;
              } else if (missing.length > 0) {
                archiveNote = `产物读取失败未归档: ${missing.join(", ")}`;
              }
            }
            await store.saveDocket(updated);
            const after = triageDocket(updated).next;
            return toolText(`${renderDocket(updated)}\n${archiveNote}\n${renderTriage(after)}`);
          }
          case "finalize": {
            const docket = await loadDocket(store, input.caseId);
            const updated = finalizeDocket(docket, input.notes);
            await store.saveDocket(updated);
            return toolText(`${renderDocket(updated)}\n案卷已定稿（phase=finalized）。`);
          }
          case "abandon": {
            if (input.reason === undefined || input.reason.trim() === "") {
              return toolText("patent_docket: abandon 需要 reason（审计留痕）");
            }
            const docket = await loadDocket(store, input.caseId);
            const updated = abandonDocket(docket, input.reason);
            await store.saveDocket(updated);
            return toolText(`${renderDocket(updated)}\n案卷已放弃（phase=abandoned）。`);
          }
          default:
            return toolText(
              `patent_docket: 未知操作 "${String(input.action)}"（可选: create / get / list / set_gaps / triage / record_revision / finalize / abandon）`,
            );
        }
      } catch (err) {
        // DocketError / 存储错误统一转文本（fail-closed，对齐 flexible_plan 风格）。
        return toolText(`patent_docket: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  };
}
