import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";

export type WorkspaceFileSpec =
  | { path: string; content: string }
  | { source: string; dest: string };

export type Task = {
  taskId: string;
  name: string;
  category: string;
  gradingType: "automated" | "llm_judge" | "hybrid";
  timeoutSeconds: number;
  workspaceFiles: WorkspaceFileSpec[];
  prompt: string;
  expectedBehavior: string;
  gradingCriteria: string[];
  automatedChecks: string | undefined;
  llmJudgeRubric: string | undefined;
  gradingWeights: Record<string, number> | undefined;
  filePath: string;
  frontmatter: Record<string, unknown>;
};

const FRONTMATTER_RE = /^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/;
const SECTION_HEADER_RE = /^##\s+(.+)$/;
const CRITERIA_ITEM_RE = /^-\s+\[[ x]\]\s+(.+)$/;

function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let currentSection: string | undefined;
  let currentLines: string[] = [];

  for (const line of body.split("\n")) {
    const headerMatch = line.match(SECTION_HEADER_RE);
    if (headerMatch) {
      if (currentSection) {
        sections[currentSection] = currentLines.join("\n").trim();
      }
      currentSection = headerMatch[1];
      currentLines = [];
    } else if (currentSection) {
      currentLines.push(line);
    }
  }
  if (currentSection) {
    sections[currentSection] = currentLines.join("\n").trim();
  }
  return sections;
}

function extractGradingCriteria(text: string): string[] {
  const criteria: string[] = [];
  for (const line of text.split("\n")) {
    const m = line.trim().match(CRITERIA_ITEM_RE);
    if (m) criteria.push(m[1]);
  }
  return criteria;
}

export function parseTask(content: string, filePath: string): Task {
  const match = content.match(FRONTMATTER_RE);
  if (!match) {
    throw new Error(`No YAML frontmatter found in ${filePath}`);
  }

  const metadata = YAML.parse(match[1]) as Record<string, unknown>;
  const sections = parseSections(match[2]);

  return {
    taskId: (metadata.id as string) ?? "",
    name: (metadata.name as string) ?? "",
    category: (metadata.category as string) ?? "",
    gradingType: (metadata.grading_type as Task["gradingType"]) ?? "automated",
    timeoutSeconds: (metadata.timeout_seconds as number) ?? 120,
    workspaceFiles: (metadata.workspace_files as WorkspaceFileSpec[]) ?? [],
    prompt: (sections["Prompt"] ?? "").trim(),
    expectedBehavior: (sections["Expected Behavior"] ?? "").trim(),
    gradingCriteria: extractGradingCriteria(sections["Grading Criteria"] ?? ""),
    automatedChecks: sections["Automated Checks"],
    llmJudgeRubric: sections["LLM Judge Rubric"],
    gradingWeights: metadata.grading_weights as Record<string, number> | undefined,
    filePath,
    frontmatter: metadata,
  };
}

export async function loadAllTasks(tasksDir: string): Promise<Task[]> {
  const entries = await readdir(tasksDir);
  const taskFiles = entries
    .filter((f) => f.startsWith("task_") && f.endsWith(".md"))
    .sort();

  const tasks: Task[] = [];
  for (const file of taskFiles) {
    const filePath = path.join(tasksDir, file);
    const content = await readFile(filePath, "utf-8");
    const task = parseTask(content, filePath);

    if ((task.frontmatter as Record<string, unknown>).multi_session) {
      continue;
    }
    tasks.push(task);
  }
  return tasks;
}
