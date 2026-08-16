/**
 * ui/server 上传服务（B1 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：multer 文件上传处理器
 * + 附件文件名清洗/规范化/移动。
 */

import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";
import mime from "mime-types";
import { extractProjectDirectory } from "../projects.js";
import { validatePathInProject } from "./filesystem.js";

const CHAT_ATTACHMENT_IMAGE_MIMES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"]);

function sanitizeAttachmentFilename(name, fallback = "attachment") {
  const baseName = path.basename(String(name || fallback));
  const sanitized = baseName
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
    .replace(/^\.+$/, fallback)
    .slice(0, 180)
    .trim();
  return sanitized || fallback;
}

function normalizeUploadedFilename(name, fallback = "attachment") {
  const original = String(name || fallback);
  try {
    const decoded = Buffer.from(original, "latin1").toString("utf8");
    const looksMojibake = /[ÃÂÄÅÆÇÈÉÊËÌÍÎÏÐÑÒÓÔÕÖØÙÚÛÜÝÞßàáâãäåæçèéêëìíîïðñòóôõöøùûüýþÿ]/.test(original);
    if (looksMojibake && decoded && !decoded.includes("�")) {
      return decoded;
    }
  } catch {
    // Keep the browser-provided name when transcoding is not applicable.
  }
  return original;
}

async function moveUploadedAttachment(file, attachmentDir, index) {
  const originalName = normalizeUploadedFilename(file.originalname, `attachment-${index + 1}`);
  file.originalname = originalName;
  const safeName = sanitizeAttachmentFilename(originalName, `attachment-${index + 1}`);
  const ext = path.extname(safeName);
  const stem = ext ? safeName.slice(0, -ext.length) : safeName;
  let candidate = `${index + 1}-${safeName}`;
  let destination = path.join(attachmentDir, candidate);
  let suffix = 1;
  while (true) {
    try {
      await fsPromises.access(destination);
      candidate = `${index + 1}-${stem}-${suffix}${ext}`;
      destination = path.join(attachmentDir, candidate);
      suffix += 1;
    } catch {
      break;
    }
  }

  await fsPromises.copyFile(file.path, destination);
  await fsPromises.unlink(file.path);
  return {
    name: originalName,
    path: destination,
    size: file.size,
    mimeType: file.mimetype || mime.lookup(originalName) || "application/octet-stream",
  };
}

// POST /api/projects/:projectName/files/upload - Upload files
// Dynamic import of multer for file uploads
const uploadFilesHandler = async (req, res) => {
  // Dynamic import of multer
  const multer = (await import("multer")).default;

  const uploadMiddleware = multer({
    storage: multer.diskStorage({
      destination: (req, file, cb) => {
        cb(null, os.tmpdir());
      },
      filename: (req, file, cb) => {
        // Use a unique temp name, but preserve original name in file.originalname
        // Note: file.originalname may contain path separators for folder uploads
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        // For temp file, just use a safe unique name without the path
        cb(null, `upload-${uniqueSuffix}`);
      },
    }),
    limits: {
      fileSize: 50 * 1024 * 1024, // 50MB limit
      files: 20, // Max 20 files at once
    },
  });

  // Use multer middleware
  uploadMiddleware.array("files", 20)(req, res, async err => {
    if (err) {
      console.error("Multer error:", err);
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({ error: "File too large. Maximum size is 50MB." });
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return res.status(400).json({ error: "Too many files. Maximum is 20 files." });
      }
      return res.status(500).json({ error: err.message });
    }

    try {
      const { projectName } = req.params;
      const { targetPath, relativePaths } = req.body;

      // Parse relative paths if provided (for folder uploads)
      let filePaths = [];
      if (relativePaths) {
        try {
          filePaths = JSON.parse(relativePaths);
        } catch (e) {
          console.log("[DEBUG] Failed to parse relativePaths:", relativePaths);
        }
      }

      console.log("[DEBUG] File upload request:", {
        projectName,
        targetPath: JSON.stringify(targetPath),
        targetPathType: typeof targetPath,
        filesCount: req.files?.length,
        relativePaths: filePaths,
      });

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No files provided" });
      }

      // Get project root
      const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
      if (!projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }

      console.log("[DEBUG] Project root:", projectRoot);

      // Validate and resolve target path
      // If targetPath is empty or '.', use project root directly
      const targetDir = targetPath || "";
      let resolvedTargetDir;

      console.log("[DEBUG] Target dir:", JSON.stringify(targetDir));

      if (!targetDir || targetDir === "." || targetDir === "./") {
        // Empty path means upload to project root
        resolvedTargetDir = path.resolve(projectRoot);
        console.log("[DEBUG] Using project root as target:", resolvedTargetDir);
      } else {
        const validation = validatePathInProject(projectRoot, targetDir);
        if (!validation.valid) {
          console.log("[DEBUG] Path validation failed:", validation.error);
          return res.status(403).json({ error: validation.error });
        }
        resolvedTargetDir = validation.resolved;
        console.log("[DEBUG] Resolved target dir:", resolvedTargetDir);
      }

      // Ensure target directory exists
      try {
        await fsPromises.access(resolvedTargetDir);
      } catch {
        await fsPromises.mkdir(resolvedTargetDir, { recursive: true });
      }

      // Move uploaded files from temp to target directory
      const uploadedFiles = [];
      console.log(
        "[DEBUG] Processing files:",
        req.files.map(f => ({ originalname: f.originalname, path: f.path })),
      );
      for (let i = 0; i < req.files.length; i++) {
        const file = req.files[i];
        // Use relative path if provided (for folder uploads), otherwise use originalname
        const fileName = filePaths && filePaths[i] ? filePaths[i] : file.originalname;
        console.log("[DEBUG] Processing file:", fileName, "(originalname:", file.originalname + ")");
        const destPath = path.join(resolvedTargetDir, fileName);

        // Validate destination path
        const destValidation = validatePathInProject(projectRoot, destPath);
        if (!destValidation.valid) {
          console.log("[DEBUG] Destination validation failed for:", destPath);
          // Clean up temp file
          await fsPromises.unlink(file.path).catch(() => {});
          continue;
        }

        // Ensure parent directory exists (for nested files from folder upload)
        const parentDir = path.dirname(destPath);
        try {
          await fsPromises.access(parentDir);
        } catch {
          await fsPromises.mkdir(parentDir, { recursive: true });
        }

        // Move file (copy + unlink to handle cross-device scenarios)
        await fsPromises.copyFile(file.path, destPath);
        await fsPromises.unlink(file.path);

        uploadedFiles.push({
          name: fileName,
          path: destPath,
          size: file.size,
          mimeType: file.mimetype,
        });
      }

      res.json({
        success: true,
        files: uploadedFiles,
        targetPath: resolvedTargetDir,
        message: `Uploaded ${uploadedFiles.length} file(s) successfully`,
      });
    } catch (error) {
      console.error("Error uploading files:", error);
      // Clean up any remaining temp files
      if (req.files) {
        for (const file of req.files) {
          await fsPromises.unlink(file.path).catch(() => {});
        }
      }
      if (error.code === "EACCES") {
        res.status(403).json({ error: "Permission denied" });
      } else {
        res.status(500).json({ error: error.message });
      }
    }
  });
};

export {
  CHAT_ATTACHMENT_IMAGE_MIMES,
  sanitizeAttachmentFilename,
  normalizeUploadedFilename,
  moveUploadedAttachment,
  uploadFilesHandler,
};
