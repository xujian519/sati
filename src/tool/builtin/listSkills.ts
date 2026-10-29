/**
 * `list_skills`：把 `<available-skills>` 里的分组按需展开。
 *
 * 背景：分组渲染让 prompt 里 `legal-*` / `patent-*` 等大组只列技能名（省 ~5k tokens），
 * 组级摘要承担域语义，但逐条描述仍可能在选技能时有用。本工具提供「组 → 名字 + 描述」
 * 的中间粒度：先看组，再按组展开描述，最后才用 `read_skill` 取全文——避免为了比较两个
 * 候选技能而各读一份 SKILL.md。
 *
 * 归组复用 `src/context/prompt/skillGroups.ts`，与实际 prompt 渲染同源，不产生第二套规则。
 */
import type { ContributedSkill } from "../../context/extension/ExtensionResolver.js";
import { groupSkills } from "../../context/prompt/skillGroups.js";
import type { SatiToolDefinition } from "../protocol/types.js";

export type ListSkillsInput = {
  group?: string;
};

export type ListSkillsDeps = {
  lister: () => { name: string; description?: string; path: string }[];
};

export type ListSkillsGroup = {
  id: string;
  label: string;
  description?: string;
  count: number;
  skills?: Array<{ name: string; description?: string }>;
};

export type ListSkillsOutput = {
  total: number;
  groups: ListSkillsGroup[];
};

export function createListSkillsTool(deps: ListSkillsDeps): SatiToolDefinition<ListSkillsInput, ListSkillsOutput> {
  return {
    name: "list_skills",
    outputSchema: {
      type: "object",
      required: ["total", "groups"],
      properties: {
        total: { type: "number" },
        groups: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              id: { type: "string" },
              label: { type: "string" },
              description: { type: "string" },
              count: { type: "number" },
              skills: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    name: { type: "string" },
                    description: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    title: "List Skills",
    description:
      "List the skill groups shown in <available-skills>, or expand one group into its skills with descriptions. " +
      "Call without a group to get group ids and counts; call with a group id (e.g. legal/litigation or patent) " +
      "to see each skill's description before choosing one for read_skill. Read-only.",
    kind: "session",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        group: {
          type: "string",
          description:
            "Group id from an <available-skills> header line, e.g. legal/litigation or patent. " +
            "A parent id such as legal expands all legal subgroups. Omit to list every group.",
        },
      },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const skills: ContributedSkill[] = deps.lister().map(entry => ({
        name: entry.name,
        description: entry.description,
        path: entry.path,
        namespace: "",
      }));
      const groups = groupSkills(skills);
      const requested = input.group?.trim().toLowerCase();
      const matched = requested
        ? groups.filter(group => group.id === requested || group.id.startsWith(`${requested}/`))
        : groups;
      const total = skills.length;

      if (matched.length === 0) {
        const ids = groups.map(group => group.id).join(", ");
        return {
          content: [
            {
              type: "text",
              text:
                `No skill group '${input.group}' found. ` +
                (ids ? `Available groups: ${ids}.` : "No skills are currently loaded."),
            },
          ],
          data: { total, groups: [] },
        };
      }

      const data: ListSkillsGroup[] = matched.map(group => ({
        id: group.id,
        label: group.label,
        ...(group.description ? { description: group.description } : {}),
        count: group.skills.length,
        ...(requested ? { skills: group.skills.map(entry => toSkillEntry(entry)) } : {}),
      }));

      const lines: string[] = [];
      for (const group of data) {
        const summary = group.description ? ` — ${group.description}` : "";
        lines.push(`- ${group.id} (${group.label}, ${group.count} skills)${summary}`);
        if (group.skills) {
          for (const entry of group.skills) {
            lines.push(`  - ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`);
          }
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        data: { total, groups: data },
        metadata: { group: requested ?? null, groupsMatched: data.length },
      };
    },
  };
}

function toSkillEntry(skill: ContributedSkill): { name: string; description?: string } {
  return { name: skill.name, ...(skill.description ? { description: skill.description } : {}) };
}
