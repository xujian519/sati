/**
 * ui/server 项目文件路由（B5-3 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：文件系统浏览/建目录/
 * 读写文件/原始字节/下载/文件树列表。
 */

import { Router } from "express";
import { promises as fsPromises } from "fs";
import path from "path";
import mime from "mime-types";
import JSZip from "jszip";
import { authenticateToken } from "../middleware/auth.js";
import {
  addDirectoryToZip,
  expandWorkspacePath,
  getFileTree,
  getSafeZipFilename,
  getWindowsDriveSuggestions,
  isWindowsDriveBrowserRoot,
  resolvePathInProject,
  sha256File,
  streamFileWithRange,
} from "../services/filesystem.js";
import { contentDispositionAttachment } from "../utils/downloadHeaders.js";
import { WORKSPACES_ROOT, validateWorkspacePath } from "./projects.js"; // 旧 projects 子路径路由
import { extractProjectDirectory } from "../projects.js"; // 项目目录解析工具
import { resolveManagedMemoryFile } from "../services/memoryService.js";

const router = Router();

router.get("/api/browse-filesystem", authenticateToken, async (req, res) => {
  try {
    const { path: dirPath } = req.query;

    console.log("[API] Browse filesystem request for path:", dirPath);
    console.log("[API] WORKSPACES_ROOT is:", WORKSPACES_ROOT);
    // Default to home directory if no path provided
    const defaultRoot = WORKSPACES_ROOT;

    if (isWindowsDriveBrowserRoot(dirPath)) {
      const suggestions = await getWindowsDriveSuggestions();
      return res.json({
        path: "/",
        suggestions,
      });
    }

    let targetPath = dirPath ? expandWorkspacePath(dirPath) : defaultRoot;

    // Resolve and normalize the path
    targetPath = path.resolve(targetPath);

    // Browsing a directory is read-only — we only list its children.
    // The actual workspace-selection validation happens in the
    // create-workspace / clone-progress endpoints, so we don't gate
    // browsing with validateWorkspacePath (which would block navigating
    // through forbidden directories like "/" to reach valid children).
    const resolvedPath = targetPath;

    // Security check - ensure path is accessible
    try {
      await fsPromises.access(resolvedPath);
      const stats = await fsPromises.stat(resolvedPath);

      if (!stats.isDirectory()) {
        return res.status(400).json({ error: "Path is not a directory" });
      }
    } catch (err) {
      return res.status(404).json({ error: "Directory not accessible" });
    }

    // Use existing getFileTree function with shallow depth (only direct children)
    const fileTree = await getFileTree(resolvedPath, 1, 0, false); // maxDepth=1, showHidden=false

    // Filter only directories and format for suggestions
    const directories = fileTree
      .filter(item => item.type === "directory")
      .map(item => ({
        path: item.path,
        name: item.name,
        type: "directory",
      }))
      .sort((a, b) => {
        const aHidden = a.name.startsWith(".");
        const bHidden = b.name.startsWith(".");
        if (aHidden && !bHidden) return 1;
        if (!aHidden && bHidden) return -1;
        return a.name.localeCompare(b.name);
      });

    // Add common directories if browsing home directory
    const suggestions = [];
    let resolvedWorkspaceRoot = defaultRoot;
    try {
      resolvedWorkspaceRoot = await fsPromises.realpath(defaultRoot);
    } catch (error) {
      // Use default root as-is if realpath fails
    }
    if (resolvedPath === resolvedWorkspaceRoot) {
      const commonDirs = ["Desktop", "Documents", "Projects", "Development", "Dev", "Code", "workspace"];
      const existingCommon = directories.filter(dir => commonDirs.includes(dir.name));
      const otherDirs = directories.filter(dir => !commonDirs.includes(dir.name));

      suggestions.push(...existingCommon, ...otherDirs);
    } else {
      suggestions.push(...directories);
    }

    res.json({
      path: resolvedPath,
      suggestions: suggestions,
    });
  } catch (error) {
    console.error("Error browsing filesystem:", error);
    res.status(500).json({ error: "Failed to browse filesystem" });
  }
});

router.post("/api/create-folder", authenticateToken, async (req, res) => {
  try {
    const { path: folderPath } = req.body;
    if (!folderPath) {
      return res.status(400).json({ error: "Path is required" });
    }
    const expandedPath = expandWorkspacePath(folderPath);
    const resolvedInput = path.resolve(expandedPath);
    const validation = await validateWorkspacePath(resolvedInput);
    if (!validation.valid) {
      return res.status(403).json({ error: validation.error });
    }
    const targetPath = validation.resolvedPath || resolvedInput;
    const parentDir = path.dirname(targetPath);
    try {
      await fsPromises.access(parentDir);
    } catch (err) {
      return res.status(404).json({ error: "Parent directory does not exist" });
    }
    try {
      await fsPromises.access(targetPath);
      return res.status(409).json({ error: "Folder already exists" });
    } catch (err) {
      // Folder doesn't exist, which is what we want
    }
    try {
      await fsPromises.mkdir(targetPath, { recursive: false });
      res.json({ success: true, path: targetPath });
    } catch (mkdirError) {
      if (mkdirError.code === "EEXIST") {
        return res.status(409).json({ error: "Folder already exists" });
      }
      throw mkdirError;
    }
  } catch (error) {
    console.error("Error creating folder:", error);
    res.status(500).json({ error: "Failed to create folder" });
  }
});

// Read file content endpoint
router.get("/api/projects/:projectName/file", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const { filePath } = req.query;

    // Security: ensure the requested path is inside the project root
    if (!filePath) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Handle both absolute and relative paths
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
      return res.status(403).json({ error: "Path must be under project root" });
    }

    // Memory-managed files (e.g. MEMORY.md) live under the memory store
    // (memory/workspaces/<hash>/memory/...) rather than the project root.
    // Try the managed location first so chat file references open the real
    // memory file, then fall back to the project-root path as before.
    const memoryCandidate = resolveManagedMemoryFile(projectRoot, path.relative(projectRoot, resolved));
    const readTargets = memoryCandidate ? [memoryCandidate, resolved] : [resolved];

    let content = null;
    let readPath = null;
    let firstError = null;
    for (const target of readTargets) {
      try {
        content = await fsPromises.readFile(target, "utf8");
        readPath = target;
        break;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if (!firstError) firstError = error;
      }
    }
    if (content === null) {
      throw firstError;
    }
    res.json({ content, path: readPath });
  } catch (error) {
    console.error("Error reading file:", error);
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "File not found" });
    } else if (error.code === "EACCES") {
      res.status(403).json({ error: "Permission denied" });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

// Serve raw file bytes for previews and downloads.
router.get("/api/projects/:projectName/files/content", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const { path: filePath } = req.query;

    // Security: ensure the requested path is inside the project root
    if (!filePath) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    const resolvedResult = resolvePathInProject(projectRoot, filePath);
    if (!resolvedResult.valid) {
      return res.status(403).json({ error: resolvedResult.error });
    }

    const resolved = resolvedResult.resolved;
    const stats = await fsPromises.stat(resolved).catch(() => null);
    if (!stats?.isFile()) {
      return res.status(404).json({ error: "File not found" });
    }

    const mimeType = mime.lookup(resolved) || "application/octet-stream";
    if (req.method === "HEAD" && (req.query.sha256 === "1" || req.query.sha256 === "true")) {
      res.setHeader("X-Sati-Content-SHA256", await sha256File(resolved));
    }
    await streamFileWithRange(req, res, resolved, {
      mimeType,
      downloadFilename: req.query.download ? path.basename(resolved) : null,
    });
  } catch (error) {
    console.error("Error serving binary file:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

router.get("/api/projects/:projectName/download", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    const rootStats = await fsPromises.stat(projectRoot).catch(() => null);
    if (!rootStats?.isDirectory()) {
      return res.status(404).json({ error: "Project directory not found" });
    }

    const zip = new JSZip();
    await addDirectoryToZip(zip, projectRoot, projectRoot);

    const filename = getSafeZipFilename(projectName);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", contentDispositionAttachment(filename));

    const zipStream = zip.generateNodeStream({
      type: "nodebuffer",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    zipStream.on("error", error => {
      console.error("Error streaming project zip:", error);
      if (!res.headersSent) {
        res.status(500).json({ error: "Failed to generate project archive" });
      } else {
        res.end();
      }
    });
    zipStream.pipe(res);
  } catch (error) {
    console.error("Error downloading project archive:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Save file content endpoint
router.put("/api/projects/:projectName/file", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const { filePath, content } = req.body;

    // Security: ensure the requested path is inside the project root
    if (!filePath) {
      return res.status(400).json({ error: "Invalid file path" });
    }

    if (content === undefined) {
      return res.status(400).json({ error: "Content is required" });
    }

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    // Handle both absolute and relative paths
    const resolved = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(projectRoot, filePath);
    const normalizedRoot = path.resolve(projectRoot) + path.sep;
    if (!resolved.startsWith(normalizedRoot)) {
      return res.status(403).json({ error: "Path must be under project root" });
    }

    // Memory-managed files must be written back to the memory store instead
    // of the project root — otherwise saving would create a shadow file at
    // <projectRoot>/MEMORY.md that the memory pipeline never reads.
    const memoryCandidate = resolveManagedMemoryFile(projectRoot, path.relative(projectRoot, resolved));
    const writeTarget = memoryCandidate ?? resolved;

    // Write the new content
    await fsPromises.writeFile(writeTarget, content, "utf8");

    res.json({
      success: true,
      path: writeTarget,
      message: "File saved successfully",
    });
  } catch (error) {
    console.error("Error saving file:", error);
    if (error.code === "ENOENT") {
      res.status(404).json({ error: "File or directory not found" });
    } else if (error.code === "EACCES") {
      res.status(403).json({ error: "Permission denied" });
    } else {
      res.status(500).json({ error: error.message });
    }
  }
});

router.get("/api/projects/:projectName/files", authenticateToken, async (req, res) => {
  try {
    // Using fsPromises from import

    // Use extractProjectDirectory to get the actual project path
    let actualPath;
    try {
      actualPath = await extractProjectDirectory(req.params.projectName);
    } catch (error) {
      console.error("Error extracting project directory:", error);
      // Fallback to simple dash replacement
      actualPath = req.params.projectName.replace(/-/g, "/");
    }

    // Check if path exists
    try {
      await fsPromises.access(actualPath);
    } catch (e) {
      return res.status(404).json({ error: `Project path not found: ${actualPath}` });
    }

    const files = await getFileTree(actualPath, 10, 0, true);
    res.json(files);
  } catch (error) {
    console.error("[ERROR] File tree error:", error.message);
    res.status(500).json({ error: error.message });
  }
});

// ============================================================================
// FILE OPERATIONS API ENDPOINTS
// ============================================================================

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */

export default router;
