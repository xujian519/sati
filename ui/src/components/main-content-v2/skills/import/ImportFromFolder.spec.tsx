// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportFromFolder } from "./ImportFromFolder";

/**
 * 导入子组件的行为测试（此前面板与导入流程**零覆盖**：切片 A 的负控制里把
 * `/api/skills/validate` 改成错误端点，全量 850 条用例仍然全绿）。
 *
 * 这里只驱动批量模式（切片 B 抽出 `BatchImportPanel` 的那条路径），断言都落在
 * 「props 边界」上：父级名、候选计数、勾选回调、scope/force 是否真的带进请求体、
 * 逐个结果文案。任何一处接线被搬坏，这些断言就会红。
 */

type ImportProps = ComponentProps<typeof ImportFromFolder>;
type Translator = ImportProps["t"];

/** `t` 是父级 SkillsV2 传下来的：测试里直接用 defaultValue 出文案（带 {{var}} 插值）。 */
const t = ((key: string, options?: Record<string, unknown>) => {
  const template = typeof options?.defaultValue === "string" ? options.defaultValue : key;
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ""));
}) as Translator;

const SCAN_RESULT = {
  parentPath: "/tmp/demo-skills",
  folders: [
    {
      folderName: "alpha",
      hasSkillMd: true,
      name: "Alpha Skill",
      description: "does alpha things",
      sourcePath: "/tmp/demo-skills/alpha",
      fileCount: 3,
      totalSize: 2048,
    },
    {
      folderName: "beta",
      hasSkillMd: true,
      name: "Beta Skill",
      description: null,
      sourcePath: "/tmp/demo-skills/beta",
      fileCount: 1,
      totalSize: 512,
    },
    {
      folderName: "gamma",
      hasSkillMd: false,
      name: null,
      description: null,
      sourcePath: "/tmp/demo-skills/gamma",
      fileCount: 1,
      totalSize: 64,
    },
  ],
};

type FetchCall = { url: string; body: unknown };

function jsonResponse(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => data,
  };
}

function installFetch(importResponder?: (slug: string) => { status: number; data: unknown }) {
  const calls: FetchCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: { body?: unknown }) => {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ url, body });
    if (url === "/api/skills/scan") return jsonResponse(SCAN_RESULT);
    if (url === "/api/skills/validate") {
      return jsonResponse({
        ok: true,
        hardFails: [],
        warnings: [],
        stats: { fileCount: 3, totalBytes: 2048 },
        frontmatter: null,
      });
    }
    if (url === "/api/skills/import") {
      const slug = (body as { slug?: string }).slug ?? "";
      const r = importResponder?.(slug) ?? { status: 200, data: { ok: true } };
      return jsonResponse(r.data, r.status);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function renderImporter(overrides: Partial<ImportProps> = {}) {
  const onImported = vi.fn();
  const utils = render(
    <ImportFromFolder projectAvailable={false} projectPath={null} onImported={onImported} t={t} {...overrides} />,
  );
  return { ...utils, onImported };
}

/** 输入路径并点 Scan，等批量面板出现。 */
async function scan() {
  fireEvent.change(screen.getByPlaceholderText("~/code/my-skill"), { target: { value: "/tmp/demo-skills" } });
  fireEvent.click(screen.getByRole("button", { name: /Scan/ }));
  await waitFor(() => expect(screen.getByText("Alpha Skill")).toBeTruthy());
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("ImportFromFolder 批量模式", () => {
  it("扫描父目录后按 skill/非 skill 分别渲染候选，并预选全部 skill", async () => {
    renderImporter();
    await scan();

    // 标题：父目录名 + 计数（3 个子目录里 2 个含 SKILL.md）
    expect(screen.getByText("demo-skills")).toBeTruthy();
    expect(screen.getByText("Found 2 skills in 3 subfolders")).toBeTruthy();
    expect(screen.getByText("alpha")).toBeTruthy();
    expect(screen.getByText("beta")).toBeTruthy();
    expect(screen.getByText("gamma")).toBeTruthy();
    // 无 SKILL.md 的目录被标注且不带勾选框
    expect(screen.getByText("(No SKILL.md)")).toBeTruthy();
    expect(screen.getAllByRole("checkbox")).toHaveLength(4); // 全选 + alpha + beta + 覆盖开关
    expect(screen.getByText("Select All (2)")).toBeTruthy();
    // 底部控件由 ScopeSelector / force 开关组成（搬进 BatchImportPanel 后仍需接线）
    expect(screen.getByText(/Scope/)).toBeTruthy(); // ScopeSelector 的标签带冒号，用正则
    expect(screen.getByText("User")).toBeTruthy();
    expect(screen.getByText("Overwrite if exists")).toBeTruthy();
    // 扫描时已把两个 skill 预先选中
    expect(screen.getByRole("button", { name: /Import 2 skills/ }).hasAttribute("disabled")).toBe(false);
    // 批量模式下输入框锁住
    expect(screen.getByPlaceholderText("~/code/my-skill").hasAttribute("disabled")).toBe(true);
  });

  it("单个勾选 / 全选切换实时反映到按钮文案与禁用态", async () => {
    renderImporter();
    await scan();

    const [, alphaBox, betaBox] = screen.getAllByRole("checkbox") as HTMLInputElement[];
    fireEvent.click(alphaBox);
    expect(screen.getByRole("button", { name: /Import 1 skills/ })).toBeTruthy();

    fireEvent.click(betaBox);
    const empty = screen.getByRole("button", { name: /Import 0 skills/ });
    expect(empty.hasAttribute("disabled")).toBe(true);

    const selectAll = screen.getAllByRole("checkbox")[0];
    fireEvent.click(selectAll);
    expect(screen.getByRole("button", { name: /Import 2 skills/ })).toBeTruthy();
  });

  it("提交后逐个回填结果，失败的项展示后端错误信息，成功则回调 onImported", async () => {
    const calls = installFetch(slug =>
      slug === "beta" ? { status: 500, data: { error: "slug exists" } } : { status: 200, data: { ok: true } },
    );
    const { onImported } = renderImporter();
    await scan();

    // 打开「覆盖」开关：勾选态由面板的 force prop 回显，值经 onForceChange 回到父级
    const forceBox = screen.getByLabelText("Overwrite if exists") as HTMLInputElement;
    expect(forceBox.checked).toBe(false);
    fireEvent.click(forceBox);
    expect(forceBox.checked).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /Import 2 skills/ }));
    await waitFor(() => expect(screen.getByText(/Batch import complete/)).toBeTruthy());

    expect(screen.getByText("Batch import complete: 1 succeeded, 1 failed")).toBeTruthy();
    expect(screen.getByText("slug exists")).toBeTruthy();

    const imports = calls.filter(c => c.url === "/api/skills/import");
    expect(imports.map(c => (c.body as { slug: string }).slug)).toEqual(["alpha", "beta"]);
    // props 边界：projectAvailable=false → scope 落到 user；force 来自开关
    expect(imports.map(c => (c.body as { scope: string }).scope)).toEqual(["user", "user"]);
    expect(imports.map(c => (c.body as { force: boolean }).force)).toEqual([true, true]);
    expect(imports.map(c => (c.body as { sourcePath: string }).sourcePath)).toEqual([
      "/tmp/demo-skills/alpha",
      "/tmp/demo-skills/beta",
    ]);

    expect(onImported).toHaveBeenCalledTimes(1);
    expect(onImported).toHaveBeenCalledWith({ slug: "alpha", name: "Alpha Skill", scope: "user" });
  });

  it("清空按钮收起面板并解锁路径输入", async () => {
    renderImporter();
    await scan();

    // 头部右侧的 X 没有文案：用「父目录名所在 header div 里的唯一 button」定位
    const header = screen.getByText("demo-skills").parentElement as HTMLElement;
    const closeButton = header.querySelector("button") as HTMLButtonElement;
    expect(closeButton).toBeTruthy();
    fireEvent.click(closeButton);

    await waitFor(() => expect(screen.queryByText("Alpha Skill")).toBeNull());
    expect(screen.getByPlaceholderText("~/code/my-skill").hasAttribute("disabled")).toBe(false);
  });
});
