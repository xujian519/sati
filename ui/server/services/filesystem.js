/**
 * ui/server 文件系统纯函数服务层（B1 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：路径校验/展开、Range
 * 流式读取、zip 打包、文件树等纯函数与常量。
 */

import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import crypto from "crypto";
import mime from "mime-types";
import { WORKSPACES_ROOT } from "../routes/projects.js";
import { contentDispositionAttachment } from "../utils/downloadHeaders.js";

const normalizeWindowsDriveRoot = inputPath => {
  if (process.platform !== "win32" || typeof inputPath !== "string") {
    return inputPath;
  }

  const trimmedPath = inputPath.trim();
  return /^[A-Za-z]:$/.test(trimmedPath) ? `${trimmedPath}\\` : inputPath;
};

const expandWorkspacePath = inputPath => {
  if (!inputPath) return inputPath;
  const normalizedInput = normalizeWindowsDriveRoot(inputPath);
  if (normalizedInput === "~") {
    return WORKSPACES_ROOT;
  }
  if (normalizedInput.startsWith("~/") || normalizedInput.startsWith("~\\")) {
    return path.join(WORKSPACES_ROOT, normalizedInput.slice(2));
  }
  return normalizedInput;
};

const isWindowsDriveBrowserRoot = inputPath => {
  if (process.platform !== "win32" || typeof inputPath !== "string") {
    return false;
  }

  const trimmedPath = inputPath.trim();
  return trimmedPath === "/" || trimmedPath === "\\";
};

const getWindowsDriveSuggestions = async () => {
  if (process.platform !== "win32") {
    return [];
  }

  const driveLetters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ".split("");
  const driveChecks = driveLetters.map(async letter => {
    const drivePath = `${letter}:\\`;
    try {
      const stats = await fsPromises.stat(drivePath);
      if (!stats.isDirectory()) {
        return null;
      }
      return {
        path: drivePath,
        name: drivePath,
        type: "directory",
      };
    } catch {
      return null;
    }
  });

  const drives = await Promise.all(driveChecks);
  return drives.filter(Boolean);
};

function resolvePathInProject(projectRoot, targetPath = "") {
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(projectRoot, targetPath);
  const normalizedRoot = path.resolve(projectRoot);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    return { valid: false, error: "Path must be under project root" };
  }

  return { valid: true, resolved };
}

function setPreviewContentType(res, filePath) {
  const mimeType = mime.lookup(filePath) || "application/octet-stream";
  const charset =
    mimeType.startsWith("text/") || mimeType === "application/javascript" || mimeType === "application/json"
      ? "; charset=utf-8"
      : "";
  res.setHeader("Content-Type", `${mimeType}${charset}`);
}

function parseRangeHeader(rangeHeader, fileSize) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(rangeHeader).trim());
  if (!match) return { invalid: true };

  const [, startPart, endPart] = match;
  if (!startPart && !endPart) return { invalid: true };

  let start;
  let end;

  if (!startPart) {
    const suffixLength = Number.parseInt(endPart, 10);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { invalid: true };
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number.parseInt(startPart, 10);
    end = endPart ? Number.parseInt(endPart, 10) : fileSize - 1;
  }

  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || start >= fileSize) {
    return { invalid: true };
  }

  return {
    start,
    end: Math.min(end, fileSize - 1),
  };
}

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

async function streamFileWithRange(req, res, filePath, options = {}) {
  const stats = await fsPromises.stat(filePath);
  const fileSize = stats.size;
  const mimeType = options.mimeType || mime.lookup(filePath) || "application/octet-stream";

  res.setHeader("Content-Type", mimeType);
  res.setHeader("Accept-Ranges", "bytes");
  if (options.cacheControl) {
    res.setHeader("Cache-Control", options.cacheControl);
  }
  if (options.pragma) {
    res.setHeader("Pragma", options.pragma);
  }
  if (options.downloadFilename) {
    res.setHeader("Content-Disposition", contentDispositionAttachment(options.downloadFilename));
  }

  if (fileSize === 0) {
    res.setHeader("Content-Length", "0");
    res.status(200).end();
    return;
  }

  const range = parseRangeHeader(req.headers.range, fileSize);
  if (range?.invalid) {
    res.status(416);
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    res.end();
    return;
  }

  const streamOptions = range ? { start: range.start, end: range.end } : undefined;
  if (range) {
    res.status(206);
    res.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${fileSize}`);
    res.setHeader("Content-Length", String(range.end - range.start + 1));
  } else {
    res.setHeader("Content-Length", String(fileSize));
  }

  if (req.method === "HEAD") {
    res.end();
    return;
  }

  const fileStream = fs.createReadStream(filePath, streamOptions);
  fileStream.pipe(res);
  fileStream.on("error", error => {
    console.error("Error streaming file:", error);
    if (!res.headersSent) {
      res.status(500).json({ error: "Error reading file" });
    } else {
      res.destroy(error);
    }
  });
}

const OFFICE_PDF_PREVIEW_EXTENSIONS = new Set([
  "doc",
  "docx",
  "wps",
  "xls",
  "xlsx",
  "et",
  "ppt",
  "pptx",
  "dps",
  "odt",
  "ods",
  "odp",
]);

const getFileExtension = filePath => path.extname(filePath).slice(1).toLowerCase();

async function addDirectoryToZip(zip, directoryPath, rootPath) {
  const entries = await fsPromises.readdir(directoryPath, { withFileTypes: true });

  for (const entry of entries) {
    const absolutePath = path.join(directoryPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");

    if (!relativePath) {
      continue;
    }

    if (entry.isDirectory()) {
      zip.folder(relativePath);
      await addDirectoryToZip(zip, absolutePath, rootPath);
      continue;
    }

    if (entry.isFile()) {
      const [content, stats] = await Promise.all([fsPromises.readFile(absolutePath), fsPromises.stat(absolutePath)]);
      zip.file(relativePath, content, { date: stats.mtime });
    }
  }
}

function getSafeZipFilename(projectName) {
  const safeName =
    String(projectName || "project")
      .replace(/[\\/:*?"<>|\x00-\x1f]/g, "-")
      .replace(/^\.+$/, "project")
      .trim() || "project";
  return `${safeName}.zip`;
}

/**
 * Validate that a path is within the project root
 * @param {string} projectRoot - The project root path
 * @param {string} targetPath - The path to validate
 * @returns {{ valid: boolean, resolved?: string, error?: string }}
 */
function validatePathInProject(projectRoot, targetPath) {
  const resolved = path.isAbsolute(targetPath) ? path.resolve(targetPath) : path.resolve(projectRoot, targetPath);
  const normalizedRoot = path.resolve(projectRoot) + path.sep;
  if (!resolved.startsWith(normalizedRoot)) {
    return { valid: false, error: "Path must be under project root" };
  }
  return { valid: true, resolved };
}

/**
 * Validate filename - check for invalid characters
 * @param {string} name - The filename to validate
 * @returns {{ valid: boolean, error?: string }}
 */
function validateFilename(name) {
  if (!name || !name.trim()) {
    return { valid: false, error: "Filename cannot be empty" };
  }
  // Check for invalid characters (Windows + Unix)
  const invalidChars = /[<>:"/\\|?*\x00-\x1f]/;
  if (invalidChars.test(name)) {
    return { valid: false, error: "Filename contains invalid characters" };
  }
  // Check for reserved names (Windows)
  const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
  if (reserved.test(name)) {
    return { valid: false, error: "Filename is a reserved name" };
  }
  // Check for dots only
  if (/^\.+$/.test(name)) {
    return { valid: false, error: "Filename cannot be only dots" };
  }
  return { valid: true };
}

// Helper function to convert permissions to rwx format
function permToRwx(perm) {
  const r = perm & 4 ? "r" : "-";
  const w = perm & 2 ? "w" : "-";
  const x = perm & 1 ? "x" : "-";
  return r + w + x;
}

async function getFileTree(dirPath, maxDepth = 3, currentDepth = 0, showHidden = true) {
  // Using fsPromises from import
  const items = [];

  try {
    const entries = await fsPromises.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      // Debug: log all entries including hidden files

      // Skip heavy build directories and VCS directories
      if (
        entry.name === "node_modules" ||
        entry.name === "dist" ||
        entry.name === "build" ||
        entry.name.startsWith(".sati") ||
        entry.name === ".tmp" ||
        /^\.sati_build\.(?:c|m)?js$/i.test(entry.name) ||
        entry.name === ".git" ||
        entry.name === ".svn" ||
        entry.name === ".hg"
      )
        continue;

      const itemPath = path.join(dirPath, entry.name);
      const item = {
        name: entry.name,
        path: itemPath,
        type: entry.isDirectory() ? "directory" : "file",
      };

      // Get file stats for additional metadata
      try {
        const stats = await fsPromises.stat(itemPath);
        item.size = stats.size;
        item.modified = stats.mtime.toISOString();

        // Convert permissions to rwx format
        const mode = stats.mode;
        const ownerPerm = (mode >> 6) & 7;
        const groupPerm = (mode >> 3) & 7;
        const otherPerm = mode & 7;
        item.permissions = ((mode >> 6) & 7).toString() + ((mode >> 3) & 7).toString() + (mode & 7).toString();
        item.permissionsRwx = permToRwx(ownerPerm) + permToRwx(groupPerm) + permToRwx(otherPerm);
      } catch {
        // If stat fails, provide default values
        item.size = 0;
        item.modified = null;
        item.permissions = "000";
        item.permissionsRwx = "---------";
      }

      if (entry.isDirectory() && currentDepth < maxDepth) {
        // Recursively get subdirectories but limit depth
        try {
          // Check if we can access the directory before trying to read it
          await fsPromises.access(item.path, fs.constants.R_OK);
          item.children = await getFileTree(item.path, maxDepth, currentDepth + 1, showHidden);
        } catch {
          // Silently skip directories we can't access (permission denied, etc.)
          item.children = [];
        }
      }

      items.push(item);
    }
  } catch (error) {
    // Only log non-permission errors to avoid spam
    if (error.code !== "EACCES" && error.code !== "EPERM") {
      console.error("Error reading directory:", error);
    }
  }

  return items.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === "directory" ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export {
  normalizeWindowsDriveRoot,
  expandWorkspacePath,
  isWindowsDriveBrowserRoot,
  getWindowsDriveSuggestions,
  resolvePathInProject,
  setPreviewContentType,
  parseRangeHeader,
  sha256File,
  streamFileWithRange,
  OFFICE_PDF_PREVIEW_EXTENSIONS,
  getFileExtension,
  addDirectoryToZip,
  getSafeZipFilename,
  validatePathInProject,
  validateFilename,
  permToRwx,
  getFileTree,
};
