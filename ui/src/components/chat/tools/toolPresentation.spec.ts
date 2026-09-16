import { describe, expect, it } from "vitest";
import { resultText, shellOutput } from "./toolPresentation";

/** Sati 真实信封（`src/tool/builtin/bash.ts#formatShellResult`）。 */
function envelope(options: {
  state?: "stdout_data" | "stderr_only" | "empty_stdout";
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
}): string {
  const state = options.state ?? "stdout_data";
  const stdout = options.stdout ?? "";
  const stderr = options.stderr ?? "";
  const lines = [
    `BASH_RESULT[success][${state}]`,
    "Assertions:",
    `- exit_code: ${options.exitCode === undefined ? 0 : (options.exitCode ?? "null")}`,
    `- stdout_visible: ${stdout.trim().length > 0}`,
    `- stderr_visible: ${stderr.trim().length > 0}`,
    `- retrieved_data_available: ${stdout.trim().length > 0}`,
    `- stdout_bytes: ${stdout.length}`,
    `- stderr_bytes: ${stderr.length}`,
    `Interpretation: Command succeeded and stdout contains visible data.`,
  ];
  if (stdout.trim().length > 0) lines.push("", "stdout:", stdout.trimEnd());
  if (stderr.trim().length > 0) lines.push("", "stderr:", stderr.trimEnd());
  return lines.join("\n");
}

describe("shellOutput 展示投影", () => {
  it("解开完整信封：正文只剩命令输出", () => {
    const result = shellOutput({ content: envelope({ stdout: "file-a\nfile-b", exitCode: 0 }) });

    expect(result.output).toBe("file-a\nfile-b");
    expect(result.exitCode).toBe(0);
    // 包装行不得出现在展示正文里
    expect(result.output).not.toContain("BASH_RESULT");
    expect(result.output).not.toContain("Assertions:");
    expect(result.output).not.toContain("Interpretation:");
    expect(result.output).not.toContain("stdout:");
    // 原文保留（不修改发给模型的那份）
    expect(result.raw).toContain("BASH_RESULT[success][stdout_data]");
  });

  it("非 0 退出码照常解开（上游正则硬编码 (0)，Sati 会产出任意整数）", () => {
    const result = shellOutput({
      content: envelope({ stdout: "partial", stderr: "ls: /nonexistent: No such file or directory", exitCode: 1 }),
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toBe("partial\n\nstderr:\nls: /nonexistent: No such file or directory");
    // 错误输出完整可见，未被吞
    expect(result.output).toContain("No such file or directory");
  });

  it("退出码为 null（超时/中断）也解开", () => {
    const result = shellOutput({ content: envelope({ stdout: "still running", exitCode: null }) });

    expect(result.exitCode).toBeNull();
    expect(result.output).toBe("still running");
  });

  it("stderr_only（无 stdout 段）也能切分", () => {
    const result = shellOutput({
      content: envelope({ state: "stderr_only", stdout: "", stderr: "permission denied", exitCode: 1 }),
    });

    expect(result.output).toBe("stderr:\npermission denied");
    expect(result.output.startsWith("stderr:")).toBe(true);
  });

  it("空输出不留假内容", () => {
    const result = shellOutput({ content: envelope({ state: "empty_stdout", stdout: "", stderr: "" }) });

    expect(result.output).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("不吞非信封文本（含形似文本与截断预览）", () => {
    const raw = "hello\nstdout:\nworld";
    expect(shellOutput({ content: raw }).output).toBe(raw);
    // 缺 Assertions 段 → 不是完整信封
    const missingAssertions = envelope({ stdout: "x" }).replace("Assertions:", "Other:");
    expect(shellOutput({ content: missingAssertions }).output).toBe(missingAssertions);
    // 只有首行（live 预览会被截断到头部）→ 原样返回
    const truncated = "BASH_RESULT[success][stdout_data]";
    expect(shellOutput({ content: truncated }).output).toBe(truncated);
  });

  it("优先用结构化数据（live 路径的 payload / 上游 toolUseResult.data）", () => {
    const structured = shellOutput({
      content: envelope({ stdout: "preview…truncated" }),
      payload: { command: "ls", stdout: "actual output", stderr: "warning", exitCode: 3, durationMs: 1300 },
    });

    expect(structured).toMatchObject({
      output: "actual output\n\nstderr:\nwarning",
      exitCode: 3,
      durationMs: 1300,
    });

    const upstreamShape = shellOutput({
      content: "ignored",
      toolUseResult: { data: { stdout: "ok", stderr: "", exitCode: 0, durationMs: 12 } },
    });
    expect(upstreamShape).toMatchObject({ output: "ok", exitCode: 0, durationMs: 12 });
  });

  it("结构化数据没有 stdout/stderr 时回退到信封（不误判其它工具的 payload）", () => {
    const result = shellOutput({
      content: envelope({ stdout: "from envelope" }),
      toolUseResult: { files: ["a.ts"] },
    });

    expect(result.output).toBe("from envelope");
  });

  it("content 为空/缺失时不炸", () => {
    expect(shellOutput(undefined)).toMatchObject({ output: "", raw: "" });
    expect(shellOutput(null)).toMatchObject({ output: "", raw: "" });
    expect(shellOutput({})).toMatchObject({ output: "", raw: "" });
  });
});

describe("resultText", () => {
  it("文本块数组拼接；其余走 JSON", () => {
    expect(
      resultText([
        { type: "text", text: "hello" },
        { type: "text", text: "world" },
      ]),
    ).toBe("hello\n\nworld");
    expect(resultText({ important: true })).toContain('"important": true');
    expect(resultText("already text")).toBe("already text");
  });
});
