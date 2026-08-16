/**
 * ui/server 会话 token 用量路由（B5-6 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：sati/cursor/gemini/
 * codex/通用 JSONL 五种会话的 token 用量统计。
 */

import { Router } from "express";
import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";
import { authenticateToken } from "../middleware/auth.js";
import { getSessionTokenBudget } from "../sati-bridge.js";
import { extractProjectDirectory } from "../projects.js";

const router = Router();

router.get("/api/projects/:projectName/sessions/:sessionId/token-usage", authenticateToken, async (req, res) => {
  try {
    const { projectName, sessionId } = req.params;
    const { provider = "sati" } = req.query;
    const homeDir = os.homedir();

    // Sati sessions use `web:s_<uuid>` keys; Windows-safe sessions
    // may use `web-s_<uuid>` because ':' is illegal in Windows filenames.
    if (provider === "sati" || /^web[:_-]s_/.test(sessionId)) {
      return res.json(getSessionTokenBudget(sessionId));
    }

    // Allow only safe characters in sessionId
    const safeSessionId = String(sessionId).replace(/[^a-zA-Z0-9._-]/g, "");
    if (!safeSessionId || safeSessionId !== String(sessionId)) {
      return res.status(400).json({ error: "Invalid sessionId" });
    }

    // Handle Cursor sessions - they use SQLite and don't have token usage info
    if (provider === "cursor") {
      return res.json({
        used: 0,
        total: 0,
        breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
        unsupported: true,
        message: "Token usage tracking not available for Cursor sessions",
      });
    }

    // Handle Gemini sessions - they are raw logs in our current setup
    if (provider === "gemini") {
      return res.json({
        used: 0,
        total: 0,
        breakdown: { input: 0, cacheCreation: 0, cacheRead: 0 },
        unsupported: true,
        message: "Token usage tracking not available for Gemini sessions",
      });
    }

    // Handle Codex sessions
    if (provider === "codex") {
      const codexSessionsDir = path.join(homeDir, ".codex", "sessions");

      // Find the session file by searching for the session ID
      const findSessionFile = async dir => {
        try {
          const entries = await fsPromises.readdir(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              const found = await findSessionFile(fullPath);
              if (found) return found;
            } else if (entry.name.includes(safeSessionId) && entry.name.endsWith(".jsonl")) {
              return fullPath;
            }
          }
        } catch (error) {
          // Skip directories we can't read
        }
        return null;
      };

      const sessionFilePath = await findSessionFile(codexSessionsDir);

      if (!sessionFilePath) {
        return res.status(404).json({ error: "Codex session file not found", sessionId: safeSessionId });
      }

      // Read and parse the Codex JSONL file
      let fileContent;
      try {
        fileContent = await fsPromises.readFile(sessionFilePath, "utf8");
      } catch (error) {
        if (error.code === "ENOENT") {
          return res.status(404).json({ error: "Session file not found", path: sessionFilePath });
        }
        throw error;
      }
      const lines = fileContent.trim().split("\n");
      let totalTokens = 0;
      let contextWindow = 200000; // Default for Codex/OpenAI

      // Find the latest token_count event with info (scan from end)
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const entry = JSON.parse(lines[i]);

          // Codex stores token info in event_msg with type: "token_count"
          if (entry.type === "event_msg" && entry.payload?.type === "token_count" && entry.payload?.info) {
            const tokenInfo = entry.payload.info;
            if (tokenInfo.total_token_usage) {
              totalTokens = tokenInfo.total_token_usage.total_tokens || 0;
            }
            if (tokenInfo.model_context_window) {
              contextWindow = tokenInfo.model_context_window;
            }
            break; // Stop after finding the latest token count
          }
        } catch (parseError) {
          // Skip lines that can't be parsed
          continue;
        }
      }

      return res.json({
        used: totalTokens,
        total: contextWindow,
      });
    }

    // Extract actual project path
    let projectPath;
    try {
      projectPath = await extractProjectDirectory(projectName);
    } catch (error) {
      console.error("Error extracting project directory:", error);
      return res.status(500).json({ error: "Failed to determine project path" });
    }

    const encodedPath = projectPath.replace(/[^a-zA-Z0-9-]/g, "-");
    const projectDir = path.join(homeDir, ".sati", "projects", encodedPath);

    const jsonlPath = path.join(projectDir, `${safeSessionId}.jsonl`);

    // Constrain to projectDir
    const rel = path.relative(path.resolve(projectDir), path.resolve(jsonlPath));
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      return res.status(400).json({ error: "Invalid path" });
    }

    // Read and parse the JSONL file
    let fileContent;
    try {
      fileContent = await fsPromises.readFile(jsonlPath, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") {
        return res.status(404).json({ error: "Session file not found", path: jsonlPath });
      }
      throw error; // Re-throw other errors to be caught by outer try-catch
    }
    const lines = fileContent.trim().split("\n");

    const parsedContextWindow = parseInt(process.env.CONTEXT_WINDOW, 10);
    const contextWindow = Number.isFinite(parsedContextWindow) ? parsedContextWindow : 160000;
    let inputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    // Find the latest assistant message with usage data (scan from end)
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);

        // Only count assistant messages which have usage data
        if (entry.type === "assistant" && entry.message?.usage) {
          const usage = entry.message.usage;

          // Use token counts from latest assistant message only
          inputTokens = usage.input_tokens || 0;
          cacheCreationTokens = usage.cache_creation_input_tokens || 0;
          cacheReadTokens = usage.cache_read_input_tokens || 0;

          break; // Stop after finding the latest assistant message
        }
      } catch (parseError) {
        // Skip lines that can't be parsed
        continue;
      }
    }

    // Calculate total context usage (excluding output_tokens, as per ccusage)
    const totalUsed = inputTokens + cacheCreationTokens + cacheReadTokens;

    res.json({
      used: totalUsed,
      total: contextWindow,
      breakdown: {
        input: inputTokens,
        cacheCreation: cacheCreationTokens,
        cacheRead: cacheReadTokens,
      },
    });
  } catch (error) {
    console.error("Error reading session token usage:", error);
    res.status(500).json({ error: "Failed to read session token usage" });
  }
});

export default router;
