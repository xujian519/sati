/**
 * export_html — 将单文件 HTML 导出为公众号内联版 / PNG / PDF / 知乎兼容版 / 校验结果。
 *
 * 封装 scripts/export-html.mjs，便于 agent 直接调用而无需通过 bash。
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { SatiToolRuntimeError } from "../protocol/errors.js";
import type { SatiToolDefinition, SatiToolRuntimeContext } from "../protocol/types.js";

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));

const SCRIPT_CANDIDATES = [
  join(HERE, "..", "..", "..", "scripts", "export-html.mjs"),
  join(HERE, "..", "..", "..", "..", "scripts", "export-html.mjs"),
];
const SCRIPT = (() => {
  const found = SCRIPT_CANDIDATES.find(path => existsSync(path));
  if (!found) {
    throw new Error("export-html.mjs not found");
  }
  return found;
})();

const TARGETS = ["wechat", "png", "pdf", "zhihu", "check"] as const;
type ExportHtmlTarget = (typeof TARGETS)[number];

export type ExportHtmlInput = {
  /** 输入 HTML 文件路径（相对当前项目根或绝对路径）。 */
  html_path: string;
  /** 导出目标，至少一个。 */
  targets: ExportHtmlTarget[];
  /** 输出目录；缺省时脚本输出到输入文件同目录。 */
  output_dir?: string;
  /** PNG 宽度（可选）。 */
  width?: number;
  /** PNG 高度（可选）。 */
  height?: number;
};

export type ExportHtmlResultItem = {
  target: ExportHtmlTarget;
  path?: string;
  message: string;
};

export type ExportHtmlOutput = {
  results: ExportHtmlResultItem[];
};

function assertTarget(value: unknown): asserts value is ExportHtmlTarget {
  if (typeof value !== "string" || !TARGETS.includes(value as ExportHtmlTarget)) {
    throw new SatiToolRuntimeError(
      "invalid_tool_input",
      `非法导出目标 "${String(value)}"（可用: ${TARGETS.join(", ")}）`,
      {
        tool: "export_html",
      },
    );
  }
}

function outputFileName(stem: string, target: ExportHtmlTarget): string {
  if (target === "wechat") return `${stem}-wechat.html`;
  if (target === "zhihu") return `${stem}-zhihu.html`;
  return `${stem}.${target}`;
}

export function createExportHtmlTool(): SatiToolDefinition<ExportHtmlInput, ExportHtmlOutput> {
  return {
    name: "export_html",
    aliases: ["ExportHtml", "export_html"],
    title: "Export HTML Deliverable",
    description:
      "Export a single-file HTML deliverable to WeChat-inlined HTML, high-DPI PNG, A4 PDF, " +
      "Zhihu-compatible HTML, or run a single-file HTML check. Delegates to scripts/export-html.mjs. " +
      "PNG is best for fixed-size cards/posters; long pages should use PDF.",
    kind: "custom",
    domain: "html",
    inputSchema: {
      type: "object",
      required: ["html_path", "targets"],
      additionalProperties: false,
      properties: {
        html_path: { type: "string", description: "Input HTML file path" },
        targets: {
          type: "array",
          items: { type: "string", enum: [...TARGETS] },
          minItems: 1,
          description: "Export targets: wechat / png / pdf / zhihu / check",
        },
        output_dir: { type: "string", description: "Optional output directory (default: alongside input)" },
        width: { type: "number", description: "PNG width in pixels (optional)" },
        height: { type: "number", description: "PNG height in pixels (optional)" },
      },
    },
    outputSchema: {
      type: "object",
      required: ["results"],
      additionalProperties: false,
      properties: {
        results: {
          type: "array",
          items: {
            type: "object",
            required: ["target", "message"],
            additionalProperties: false,
            properties: {
              target: { type: "string" },
              path: { type: "string" },
              message: { type: "string" },
            },
          },
        },
      },
    },
    isReadOnly: () => false,
    isConcurrencySafe: () => true,
    async execute(input, context: SatiToolRuntimeContext) {
      const htmlPath = isAbsolute(input.html_path) ? input.html_path : resolve(context.cwd, input.html_path);
      if (!existsSync(htmlPath) || !statSync(htmlPath).isFile()) {
        throw new SatiToolRuntimeError("invalid_tool_input", `HTML 文件不存在: ${htmlPath}`, {
          tool: "export_html",
          html_path: input.html_path,
        });
      }

      for (const target of input.targets) {
        assertTarget(target);
      }

      const outputDir = input.output_dir ? resolve(context.cwd, input.output_dir) : undefined;
      if (outputDir) {
        mkdirSync(outputDir, { recursive: true });
      }

      const stem = basename(htmlPath, extname(htmlPath));
      const results: ExportHtmlResultItem[] = [];

      for (const target of input.targets) {
        const outputPath =
          target === "check" ? undefined : join(outputDir ?? dirname(htmlPath), outputFileName(stem, target));

        const args: string[] = [SCRIPT, target, htmlPath];
        if (outputPath) args.push(outputPath);
        if (target === "png") {
          if (input.width !== undefined) args.push("--width", String(input.width));
          if (input.height !== undefined) args.push("--height", String(input.height));
        }

        try {
          const { stdout, stderr } = await execFileAsync(process.execPath, args, {
            cwd: context.cwd,
            timeout: 120_000,
          });
          const message = (stdout || stderr).trim();
          results.push({
            target,
            ...(outputPath && existsSync(outputPath) ? { path: outputPath } : {}),
            message,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          throw new SatiToolRuntimeError("tool_execution_failed", `export_html ${target} 失败: ${message}`, {
            tool: "export_html",
            target,
          });
        }
      }

      const lines = results.map(r => `- ${r.target}: ${r.path ?? r.message}`);
      const fileBlocks = results.flatMap(r => {
        if (!r.path) return [];
        return [
          {
            type: "file" as const,
            path: r.path,
            mimeType: r.path.endsWith(".pdf") ? "application/pdf" : "text/html",
            description: `Exported ${r.target}`,
          },
        ];
      });

      return {
        content: [{ type: "text", text: [`**export_html**`, "", ...lines].join("\n") }, ...fileBlocks],
        data: { results },
      };
    },
  };
}
