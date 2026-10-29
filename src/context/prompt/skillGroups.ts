/**
 * 技能清单分组——**纯渲染层概念**，不改技能注册与目录结构。
 *
 * 背景：内置技能到 225 个（其中 `legal-*` 131 个），逐条 `- name — description`
 * 的平铺清单约 9.8k tokens，占固定开销的大头；而技能名本身是结构化 slug
 * （`legal-<域>-<动作>`），已能表达"管什么"。因此清单按域分组，**大而规则的组只列
 * 名字**（compact），由组级一句话摘要承担选技能所需的语义；名字不透明的小组
 * （`gog` / `tmux` / `pdf` 这类品牌名）仍逐条保留描述。
 *
 * 归组只用 slug 前缀规则，**不建子目录**：`SkillManager.listSkillsIn()` 是单层
 * `readdir`，加一层目录会让技能注册失效；分组规则对新增 `legal-*` 自动生效
 * （第二段即子域），未命中任何规则的技能落 `general`，不需要手工重排。
 *
 * 可逆性：`read_skill` 仍按名字取全文，分组不改变任何技能的可达性。
 */
import type { ContributedSkill } from "../extension/ExtensionResolver.js";

export type SkillGroup = {
  id: string;
  label: string;
  /** 组级一句话摘要；compact 组必填（逐条描述被省掉后由它承担语义）。 */
  description?: string;
  /** true = 只列技能名（省略逐条 description）；false = 逐条保留描述。 */
  compact: boolean;
  /** 渲染顺序（来自分类表；未知组排最后）。 */
  order: number;
  skills: ContributedSkill[];
};

type LegalDomainMeta = { label: string; description: string };

/** 法务子域。顺序即渲染顺序；新增子域不在此表时按字母序自动补位。 */
const LEGAL_DOMAINS: Record<string, LegalDomainMeta> = {
  litigation: {
    label: "Litigation",
    description: "Matters, demand letters, pleadings, discovery, privilege logs, and hearing prep.",
  },
  employment: {
    label: "Employment",
    description:
      "Hiring, policy drafting, internal investigations, leave tracking, termination, and wage-hour questions.",
  },
  corporate: {
    label: "Corporate",
    description: "Diligence, closing checklists, board minutes, entity compliance, and integration management.",
  },
  ip: {
    label: "IP",
    description: "Clearance, FTO triage, infringement triage, takedowns, portfolio, and IP clause review.",
  },
  commercial: {
    label: "Commercial",
    description: "NDA/SaaS/MSA review, escalation, renewals, amendment history, and vendor agreements.",
  },
  ai: {
    label: "AI",
    description: "AI use-case triage, policy drafting, regulatory gap analysis, and vendor AI review.",
  },
  regulatory: {
    label: "Regulatory",
    description: "Regulatory gap surfacing, comment drafting, policy diff/redraft, and regulation feed watching.",
  },
  privacy: {
    label: "Privacy",
    description: "DPA review, DSAR response, PIA generation, privacy policy monitoring, and gap analysis.",
  },
  criminal: {
    label: "Criminal",
    description: "Case analysis, defense strategy, bail applications, and non-prosecution compliance.",
  },
  product: {
    label: "Product",
    description: "Launch review, feature risk assessment, and marketing claims review.",
  },
  research: {
    label: "Research",
    description: "Issue memos, authority checks, case comparison, and lecture source packs.",
  },
  procurement: {
    label: "Procurement",
    description: "Bid review, challenge complaints, contract performance, and procurement regime triage.",
  },
  practice: {
    label: "Practice",
    description: "Complaint triage, consultation analysis, and legal service proposals.",
  },
  citation: { label: "Citation", description: "Verify citations against primary sources." },
  quality: { label: "Quality", description: "Pre-delivery quality gate for legal work product." },
};

/** 非 `legal-*` 的域/职能分组。`match` 全部小写比较。 */
type FamilyRule = {
  id: string;
  label: string;
  description: string;
  /** 大而规则、名字自解释的组 → 只列名字。 */
  compact: boolean;
  order: number;
  match: (loweredName: string) => boolean;
};

const EXACT = (names: readonly string[]) => (name: string) => names.includes(name);

const FAMILY_RULES: FamilyRule[] = [
  {
    id: "patent",
    label: "Patent",
    description:
      "Prior-art search and download, claim/spec drafting, prosecution, and validity/patentability/infringement analysis.",
    compact: true,
    order: 0,
    // 与 isPatentSkillName 的前缀集合保持一致（非专利工作区整组不渲染）。
    match: name => /^(patent|provision|drafting)-/.test(name),
  },
  {
    id: "office",
    label: "Office documents",
    description: "Word/Excel/PowerPoint/PDF authoring and editing.",
    compact: false,
    order: 100,
    match: EXACT(["docx", "pptx", "xlsx", "pdf", "spreadsheets"]),
  },
  {
    id: "html",
    label: "HTML deliverables",
    description: "Self-contained HTML reports, decks, posters, and social cards.",
    compact: false,
    order: 110,
    match: name => name.startsWith("html-"),
  },
  {
    id: "design",
    label: "Design & frontend",
    description: "Frontend design systems, slide decks, diagrams, and React/Next conventions.",
    compact: false,
    order: 120,
    match: EXACT([
      "frontend-design",
      "frontend-slides",
      "web-design-guidelines",
      "diagram-maker",
      "react-next-best-practices",
    ]),
  },
  {
    id: "integrations",
    label: "Apps & integrations",
    description: "External apps and CLIs: notes, mail, tasks, repos, remote hosts, and secrets.",
    compact: false,
    order: 130,
    match: name =>
      EXACT([
        "1password",
        "bear-notes",
        "github",
        "gog",
        "himalaya",
        "notion",
        "obsidian",
        "trello",
        "weather",
        "tmux",
        "powershell",
      ])(name) || name.startsWith("apple-"),
  },
  {
    id: "research",
    label: "Research & authoring",
    description: "Browsing, source discovery, summarization, patent office queries, and skill authoring.",
    compact: false,
    order: 140,
    match: EXACT([
      "blogwatcher",
      "browser-use",
      "ego-browser",
      "find-skills",
      "skill-creator",
      "sati-skills-migration",
      "summarize",
      "meeting-recorder-assistant",
      "spike",
      "karpathy-guidelines",
      "cnipa-query",
      "google-patents-search",
      "chemical-structure-recognition",
    ]),
  },
];

const LEGAL_FALLBACK: LegalDomainMeta = {
  label: "General",
  description: "Workspace setup, matter intake, and shared legal orchestration entry points.",
};

const LEGAL_COMPACT = true;
const LEGAL_BASE_ORDER = 10;
const GENERAL_ORDER = 900;

/** 单个技能归属的分组元信息（不依赖其他技能，可单测）。 */
export type SkillGroupMeta = {
  id: string;
  label: string;
  description?: string;
  compact: boolean;
  order: number;
};

/**
 * 解析技能名 → 分组。规则顺序即优先级：
 * `legal-<域>-*` → 法务子域；其余 `legal-*` → `legal/other`；
 * 已登记家族（patent / office / html / design / integrations / research）；
 * 其余 → `general`（新增技能不用手工重排）。
 */
export function skillGroupFor(name: string): SkillGroupMeta {
  const lowered = name.toLowerCase();

  if (lowered.startsWith("legal-")) {
    const domain = /^legal-([a-z0-9]+)-/.exec(lowered)?.[1];
    if (domain) {
      const meta = LEGAL_DOMAINS[domain];
      const known = LEGAL_DOMAIN_KEYS.indexOf(domain);
      return {
        id: `legal/${domain}`,
        label: `Legal · ${meta ? meta.label : titleCase(domain)}`,
        description: meta?.description,
        compact: LEGAL_COMPACT,
        order: LEGAL_BASE_ORDER + (known >= 0 ? known : LEGAL_DOMAIN_KEYS.length + hashSlot(domain)),
      };
    }
    return {
      id: "legal/other",
      label: `Legal · ${LEGAL_FALLBACK.label}`,
      description: LEGAL_FALLBACK.description,
      compact: LEGAL_COMPACT,
      order: LEGAL_BASE_ORDER + LEGAL_DOMAIN_KEYS.length,
    };
  }

  for (const rule of FAMILY_RULES) {
    if (rule.match(lowered)) {
      return {
        id: rule.id,
        label: rule.label,
        description: rule.description,
        compact: rule.compact,
        order: rule.order,
      };
    }
  }

  return {
    id: "general",
    label: "General",
    description: "Skills that do not match a registered domain prefix yet.",
    compact: false,
    order: GENERAL_ORDER,
  };
}

/** 按分组归并技能；组内保持调用方给的顺序，组间按 `order`、再按 label。 */
export function groupSkills(skills: ContributedSkill[]): SkillGroup[] {
  const groups = new Map<string, SkillGroup>();
  for (const skill of skills) {
    const meta = skillGroupFor(skill.name);
    const existing = groups.get(meta.id);
    if (existing) {
      existing.skills.push(skill);
      continue;
    }
    groups.set(meta.id, {
      id: meta.id,
      label: meta.label,
      description: meta.description,
      compact: meta.compact,
      order: meta.order,
      skills: [skill],
    });
  }
  return [...groups.values()].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

/** 已知法务子域顺序（渲染顺序）；新增子域按名字稳定散列排在其后。 */
const LEGAL_DOMAIN_KEYS = Object.keys(LEGAL_DOMAINS);

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** 未登记子域的稳定槽位（0-49），避免按字母序重排已有子域。 */
function hashSlot(value: string): number {
  let hash = 0;
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) % 50;
  }
  return hash;
}
