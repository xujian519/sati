// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authenticatedFetch } from "../../utils/api";
import type { Project } from "../../types/app";
import SkillsV2 from "./SkillsV2";

vi.mock("../../utils/api", () => ({
  authenticatedFetch: vi.fn(),
  api: { sessionModelContext: vi.fn() },
}));

vi.mock("../../contexts/ThemeContext", () => ({
  useTheme: () => ({ isDarkMode: false }),
}));

vi.mock("@uiw/react-codemirror", () => ({
  default: () => null,
}));

vi.mock("./skills/import/ImportFromFolder", () => ({
  ImportFromFolder: () => null,
}));

const project = {
  name: "demo",
  displayName: "Demo",
  path: "/tmp/demo",
  fullPath: "/tmp/demo",
} as Project;

function response(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

const listBody = {
  builtin: [],
  user: [
    {
      slug: "pdf",
      name: "pdf",
      description: "PDF tooling",
      version: null,
      skillFile: "/tmp/home/skills/pdf/SKILL.md",
      skillDir: "/tmp/home/skills/pdf",
      scope: "user" as const,
      readonly: false,
      mtime: 1,
      enabled: true,
    },
  ],
  project: [],
  projectPath: "/tmp/demo",
  isGeneralCwd: false,
};

const mockedFetch = vi.mocked(authenticatedFetch);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SkillsV2 enablement", () => {
  it("切换开关写入偏好端点并刷新列表", async () => {
    mockedFetch.mockImplementation(async (url: string) => {
      if (url === "/api/skills/list") return response(listBody);
      if (url === "/api/skills/preferences") return response({ ok: true, enabled: false });
      throw new Error(`unexpected url ${url}`);
    });

    render(<SkillsV2 selectedProject={project} projects={[project]} compact />);

    const toggle = await screen.findByRole("switch", { name: "Disable" });
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(mockedFetch).toHaveBeenCalledWith(
        "/api/skills/preferences",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({
            scope: "user",
            slug: "pdf",
            projectKey: undefined,
            enabled: false,
          }),
        }),
      );
    });

    const listCalls = mockedFetch.mock.calls.filter(([url]) => url === "/api/skills/list");
    expect(listCalls.length).toBeGreaterThanOrEqual(2);
  });
});
