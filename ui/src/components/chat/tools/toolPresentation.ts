import type { ToolResult } from "../types/types";

export type ShellOutput = {
  /** 展示用正文：stdout（存在 stderr 时追加 `stderr:` 段）。 */
  output: string;
  exitCode?: number | null;
  durationMs?: number;
  /** 原始文本（回退与行数统计用）。 */
  raw: string;
};

export function displayText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value == null) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // JSON.stringify 抛错（循环引用/BigInt 等不可序列化值）→ 退回 String(value)（普通对象得到 "[object Object]"），保证仍返回 string 而不把异常抛给渲染方。
    return String(value);
  }
}

export function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      return objectValue(JSON.parse(value));
    } catch {
      // JSON.parse 抛错（字符串不是合法 JSON）→ 返回空对象 {}，调用方 structuredShellData 据此跳过该候选、回退到信封文本解析。
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function resultText(value: unknown): string {
  if (Array.isArray(value) && value.every(item => item?.type === "text" && typeof item.text === "string")) {
    return value.map(item => (item as { text: string }).text).join("\n\n");
  }
  return displayText(value);
}

/**
 * 工具结果里的结构化 shell 数据。
 *
 * 两处来源：live 路径把工具返回的 `data` 挂成 frame 的 `payload`（`bash` 的
 * `{stdout, stderr, exitCode, durationMs, ...}` 是平铺的）；上游形状则把同一份数据
 * 放在 `toolUseResult.data` 下。两条都试，都不命中即返回 undefined（回退到信封解析，
 * 再不行就原样显示）。
 */
function structuredShellData(result: ToolResult | null | undefined): Record<string, unknown> | undefined {
  for (const candidate of [result?.payload, result?.toolUseResult]) {
    const record = objectValue(candidate);
    for (const item of [record, objectValue(record.data)]) {
      if (typeof item.stdout === "string" || typeof item.stderr === "string") return item;
    }
  }
  return undefined;
}

/** 去掉 section 标签行（`stdout:` / `stderr:`），保留其后正文。 */
function stripSectionLabel(text: string, label: string): string {
  const prefix = `${label}:\n`;
  return text.startsWith(prefix) ? text.slice(prefix.length) : text;
}

/** 切分信封尾部：stdout 段与 stderr 段都可能单独出现（顺序固定，stdout 在前）。 */
function splitShellSections(body: string): { stdout: string; stderr: string } {
  const trimmed = body.trimEnd();
  if (!trimmed) return { stdout: "", stderr: "" };
  if (trimmed.startsWith("stderr:")) return { stdout: "", stderr: stripSectionLabel(trimmed, "stderr") };
  const stdoutBody = stripSectionLabel(trimmed, "stdout");
  const separator = "\n\nstderr:\n";
  const index = stdoutBody.indexOf(separator);
  if (index < 0) return { stdout: stdoutBody, stderr: "" };
  return { stdout: stdoutBody.slice(0, index), stderr: stdoutBody.slice(index + separator.length) };
}

/**
 * Sati 的 `BASH_RESULT` 信封（`src/tool/builtin/bash.ts`）。
 *
 * 与上游的差异：退出码可为任意整数，也会是 `null`（超时/中断），故不能像上游那样
 * 硬编码 `(0)`；且 Sati 在 stdout 之后还会追加 `stderr:` 段。
 *
 * 只匹配**完整**信封：任何缺行、截断预览（live 预览会被截断）或形似文本都原样返回，
 * 绝不吞内容。
 */
const SHELL_ENVELOPE_RE =
  /^BASH_RESULT\[success\]\[(stdout_data|stderr_only|empty_stdout)\]\nAssertions:\n- exit_code: (-?\d+|null)\n- stdout_visible: (?:true|false)\n- stderr_visible: (?:true|false)\n- retrieved_data_available: (?:true|false)\n- stdout_bytes: \d+\n- stderr_bytes: \d+\nInterpretation: [^\n]+(?:\n\n([\s\S]*))?$/;

/** 正文装配：stdout 与 stderr 各自成段，stderr 带 `stderr:` 标签。 */
function joinShellSections(stdout: string, stderr: string): string {
  return [stdout, stderr ? `stderr:\n${stderr}` : ""].filter(Boolean).join("\n\n");
}

/**
 * shell 类工具结果的展示投影。
 *
 * 纯展示：**不改变**发给模型的结果（信封里的 Assertions / Interpretation 是给模型的
 * 证据，只是在 UI 上是包装噪声）。
 *
 * 入参放宽到 `string`：渲染层把非 JSON 的负载按原样传入（`ToolRenderer` 的
 * `parsedData` 分支），此时没有结构化字段可用，只有信封解析一条路。
 */
export function shellOutput(result: ToolResult | string | null | undefined): ShellOutput {
  const raw = typeof result === "string" ? result : resultText(result?.content);
  const structured = typeof result === "string" ? undefined : structuredShellData(result);
  if (structured) {
    const stdout = typeof structured.stdout === "string" ? structured.stdout : "";
    const stderr = typeof structured.stderr === "string" ? structured.stderr : "";
    return {
      output: joinShellSections(stdout, stderr),
      exitCode: typeof structured.exitCode === "number" ? structured.exitCode : null,
      durationMs: typeof structured.durationMs === "number" ? structured.durationMs : undefined,
      raw,
    };
  }

  const match = SHELL_ENVELOPE_RE.exec(raw.replace(/\r\n/g, "\n"));
  if (!match) return { output: raw, raw };
  // 捕获组：1 = outputState，2 = 退出码，3 = stdout/stderr 段（无段时 undefined）
  const { stdout, stderr } = splitShellSections(match[3] ?? "");
  const exitCodeText = match[2] ?? "null";
  return {
    output: joinShellSections(stdout, stderr),
    exitCode: exitCodeText === "null" ? null : Number(exitCodeText),
    durationMs: undefined,
    raw,
  };
}
