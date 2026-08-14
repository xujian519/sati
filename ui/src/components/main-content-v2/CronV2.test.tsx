// @vitest-environment jsdom
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CronJobOverview, Project } from "../../types/app";
import CronV2 from "./CronV2";

const apiMock = vi.hoisted(() => ({
  projects: vi.fn(),
  allCronJobs: vi.fn(),
  cronCreate: vi.fn(),
  cronUpdate: vi.fn(),
  cronDelete: vi.fn(),
  cronRunNow: vi.fn(),
  cronStop: vi.fn(),
}));

vi.mock("../../utils/api", () => ({
  api: apiMock,
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, unknown>) =>
      typeof options?.defaultValue === "string" ? options.defaultValue : _key,
  }),
}));

const project: Project = {
  name: "general",
  displayName: "General",
  fullPath: "/project/general",
};

function jsonResponse<T>(body: T, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: vi.fn(async () => body),
  } as unknown as Response;
}

function makeJob(overrides: Partial<CronJobOverview>): CronJobOverview {
  return {
    id: "job-1",
    projectKey: "/project/general",
    cron: "0 * * * *",
    prompt: "Run hourly report",
    createdAt: "2026-01-01T00:00:00.000Z",
    recurring: true,
    manualOnly: false,
    status: "scheduled",
    ...overrides,
  };
}

function setup(jobs: CronJobOverview[]) {
  apiMock.projects.mockResolvedValue(jsonResponse([project]));
  apiMock.allCronJobs.mockResolvedValue(jsonResponse({ jobs }));
  apiMock.cronCreate.mockResolvedValue(jsonResponse({ task: { taskId: "created-task" } }));
  apiMock.cronUpdate.mockResolvedValue(jsonResponse({ task: { taskId: "updated-task" } }));
  apiMock.cronRunNow.mockResolvedValue(jsonResponse({ triggered: true }));
  apiMock.cronStop.mockResolvedValue(jsonResponse({ stopped: true }));
  apiMock.cronDelete.mockResolvedValue(jsonResponse({ deleted: true }));

  return render(<CronV2 />);
}

describe("CronV2", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("loads active cron jobs and groups them by project", async () => {
    setup([
      makeJob({
        id: "job-1",
        prompt: "Run hourly report",
        projectKey: "/project/general",
        nextRunAt: "2026-01-01T01:00:00.000Z",
      }),
      makeJob({ id: "job-2", prompt: "Unassigned check", projectKey: null }),
      makeJob({ id: "job-3", prompt: "Completed old job", status: "completed" }),
    ]);

    await screen.findByText("General");
    expect(screen.getAllByText("Next Run").length).toBeGreaterThan(0);
    expect(screen.getByText("Run hourly report")).toBeTruthy();
    expect(screen.getByText(formatExpectedTime("2026-01-01T01:00:00.000Z"))).toBeTruthy();
    expect(screen.getByText("Unassigned")).toBeTruthy();
    expect(screen.getByText("Unassigned check")).toBeTruthy();
    expect(screen.queryByText("Completed old job")).toBeNull();
  });

  it("shows cron sub-navigation and defaults to the task list", async () => {
    setup([makeJob({ prompt: "Visible list task" })]);

    expect(screen.getByRole("button", { name: "Task List" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Task" })).toBeTruthy();
    await screen.findByText("Visible list task");
  });

  it("creates a one-time cron task and refreshes the list", async () => {
    setup([]);

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Create Cron Task");

    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Run a focused review" },
    });
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/project/general" },
    });
    fireEvent.change(screen.getByLabelText("Date"), {
      target: { value: "2099-01-01" },
    });
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "10:00" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Run a focused review",
          projectKey: "/project/general",
          schedule: expect.objectContaining({ type: "once" }),
        }),
      );
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it("creates a recurring cron task", async () => {
    setup([]);

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Create Cron Task");
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Daily digest" },
    });
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/project/general" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recurring" }));
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "08:30" },
    });
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Asia/Shanghai" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Daily digest",
          projectKey: "/project/general",
          timezone: "Asia/Shanghai",
          schedule: {
            type: "cron",
            expression: "30 8 * * *",
            timezone: "Asia/Shanghai",
          },
        }),
      );
    });
  });

  it("validates required create fields before calling the API", async () => {
    setup([]);

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Create Cron Task");
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" }).at(-1)!);

    await screen.findByText("Prompt is required.");
    expect(apiMock.cronCreate).not.toHaveBeenCalled();
  });

  it("runs a scheduled cron job immediately and refreshes", async () => {
    setup([makeJob({ id: "job-run", prompt: "Run this now", status: "scheduled" })]);

    await screen.findByText("Run this now");
    fireEvent.click(screen.getByRole("button", { name: /Run Now/ }));

    await waitFor(() => {
      expect(apiMock.cronRunNow).toHaveBeenCalledWith("job-run");
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it("stops a running cron job and refreshes", async () => {
    setup([makeJob({ id: "job-stop", prompt: "Stop this job", status: "running" })]);

    await screen.findByText("Stop this job");
    fireEvent.click(screen.getByRole("button", { name: /Stop/ }));

    await waitFor(() => {
      expect(apiMock.cronStop).toHaveBeenCalledWith("job-stop");
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it("deletes a cron job only after inline confirmation", async () => {
    setup([makeJob({ id: "job-delete", prompt: "Delete this job" })]);

    await screen.findByText("Delete this job");
    fireEvent.click(screen.getByTitle("Delete"));
    expect(apiMock.cronDelete).not.toHaveBeenCalled();

    // 确认前可取消
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(apiMock.cronDelete).not.toHaveBeenCalled();

    // 再次进入确认态并确认删除
    fireEvent.click(screen.getByTitle("Delete"));
    fireEvent.click(screen.getByRole("button", { name: "Delete Task" }));

    await waitFor(() => {
      expect(apiMock.cronDelete).toHaveBeenCalledWith("job-delete");
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it("edits a recurring cron task with prefilled values and saves changes", async () => {
    setup([
      makeJob({
        id: "job-edit",
        prompt: "Edit me",
        cron: "30 8 * * 1",
        recurring: true,
        timezone: "Asia/Shanghai",
        revision: 3,
        nextRunAt: "2026-01-05T00:30:00.000Z",
      }),
    ]);

    await screen.findByText("Edit me");
    fireEvent.click(screen.getByTitle("Edit"));

    await screen.findByText("Edit Cron Task");
    // 回填断言：prompt / 时区 / 频率（30 8 * * 1 → weekly 周一 08:30）
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Edit me");
    expect((screen.getByLabelText("Timezone") as HTMLInputElement).value).toBe("Asia/Shanghai");
    expect((screen.getByLabelText("Time") as HTMLInputElement).value).toBe("08:30");
    // 30 8 * * 1 → weekly 周一（value 1）选中
    expect(screen.getByRole("button", { name: "Mon" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Tue" }).getAttribute("aria-pressed")).toBe("false");

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Updated prompt" } });
    fireEvent.change(screen.getByLabelText("Time"), { target: { value: "09:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith(
        "job-edit",
        expect.objectContaining({
          message: "Updated prompt",
          projectKey: "/project/general",
          expectedRevision: 3,
          schedule: expect.objectContaining({ type: "cron", expression: "0 9 * * 1" }),
        }),
      );
      expect(apiMock.allCronJobs).toHaveBeenCalledTimes(2);
    });
  });

  it("surfaces a conflict error when the task was modified elsewhere", async () => {
    setup([
      makeJob({
        id: "job-conflict",
        prompt: "Conflict me",
        revision: 3,
      }),
    ]);
    apiMock.cronUpdate.mockResolvedValue(jsonResponse({ updated: false, reason: "conflict" }, false));

    await screen.findByText("Conflict me");
    fireEvent.click(screen.getByTitle("Edit"));
    await screen.findByText("Edit Cron Task");
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(screen.getByText("This task was modified elsewhere. Refresh the list and try again.")).toBeTruthy();
    });
    expect(apiMock.cronUpdate).toHaveBeenCalledWith("job-conflict", expect.objectContaining({ expectedRevision: 3 }));
  });

  it("creates a weekly cron task from selected weekdays", async () => {
    setup([]);

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Create Cron Task");
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Weekly digest" },
    });
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/project/general" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recurring" }));
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.change(screen.getByLabelText("Time"), {
      target: { value: "09:15" },
    });
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Asia/Shanghai" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Mon" }));
    fireEvent.click(screen.getByRole("button", { name: "Fri" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Weekly digest",
          schedule: {
            type: "cron",
            expression: "15 9 * * 1,5",
            timezone: "Asia/Shanghai",
          },
        }),
      );
    });
  });

  it("creates a cron task from a custom 5-field expression", async () => {
    setup([]);

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Create Cron Task");
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "Custom schedule" },
    });
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/project/general" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recurring" }));
    fireEvent.click(screen.getByRole("button", { name: "Custom (cron)" }));
    fireEvent.change(screen.getByLabelText("Cron Expression"), {
      target: { value: "0 9 * * 1" },
    });
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "UTC" },
    });
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" }).at(-1)!);

    await waitFor(() => {
      expect(apiMock.cronCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          message: "Custom schedule",
          schedule: { type: "cron", expression: "0 9 * * 1", timezone: "UTC" },
        }),
      );
    });
  });

  it("falls back to custom frequency when editing an unparseable cron expression", async () => {
    setup([
      makeJob({
        id: "job-unparseable",
        prompt: "Range schedule",
        cron: "0 9 * * 1-5",
        recurring: true,
        timezone: "UTC",
      }),
    ]);

    await screen.findByText("Range schedule");
    fireEvent.click(screen.getByTitle("Edit"));

    await screen.findByText("Edit Cron Task");
    // 不可解析表达式（1-5 区间）落到 custom，原始表达式保留
    expect((screen.getByLabelText("Cron Expression") as HTMLInputElement).value).toBe("0 9 * * 1-5");

    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Edited range" } });
    fireEvent.click(screen.getByRole("button", { name: "Save Changes" }));

    await waitFor(() => {
      expect(apiMock.cronUpdate).toHaveBeenCalledWith(
        "job-unparseable",
        expect.objectContaining({
          schedule: expect.objectContaining({ type: "cron", expression: "0 9 * * 1-5" }),
        }),
      );
    });
  });

  it("clears edit state when switching back to the task list tab", async () => {
    setup([makeJob({ id: "job-tab", prompt: "Tab task", cron: "0 9 * * 1", recurring: true, timezone: "UTC" })]);

    await screen.findByText("Tab task");
    fireEvent.click(screen.getByTitle("Edit"));
    await screen.findByText("Edit Cron Task");

    // 切回列表再进创建 → 应为新建表单而非编辑残留
    fireEvent.click(screen.getByRole("button", { name: "Task List" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" })[0]);

    await screen.findByText("Create Cron Task");
    expect(screen.queryByText("Edit Cron Task")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save Changes" })).toBeNull();
  });

  it("disables the workspace selector while editing", async () => {
    setup([makeJob({ id: "job-ws", prompt: "Workspace locked", cron: "0 9 * * 1", recurring: true, timezone: "UTC" })]);

    await screen.findByText("Workspace locked");
    fireEvent.click(screen.getByTitle("Edit"));
    await screen.findByText("Edit Cron Task");

    expect((screen.getByLabelText("Workspace") as HTMLSelectElement).disabled).toBe(true);
  });

  it("validates weekly frequency requires at least one weekday", async () => {
    setup([]);

    fireEvent.click(screen.getByRole("button", { name: "Create Task" }));
    await screen.findByText("Create Cron Task");
    fireEvent.change(screen.getByLabelText("Prompt"), {
      target: { value: "No weekday" },
    });
    fireEvent.change(screen.getByLabelText("Workspace"), {
      target: { value: "/project/general" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Recurring" }));
    fireEvent.click(screen.getByRole("button", { name: "Weekly" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Create Task" }).at(-1)!);

    await screen.findByText("Select at least one weekday.");
    expect(apiMock.cronCreate).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no active cron jobs", async () => {
    setup([makeJob({ id: "job-complete", prompt: "Past job", status: "completed" })]);

    await screen.findByText("No active cron jobs found.");
    expect(screen.queryByText("Past job")).toBeNull();
  });

  it("renders a placeholder when next run time is missing", async () => {
    setup([makeJob({ id: "job-missing-next-run", prompt: "Missing next run" })]);

    await screen.findByText("Missing next run");
    expect(screen.getByText("—")).toBeTruthy();
  });
});

function formatExpectedTime(iso: string): string {
  return new Date(Date.parse(iso)).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}
