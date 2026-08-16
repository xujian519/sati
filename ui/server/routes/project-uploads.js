/**
 * ui/server 项目上传路由（B5-5 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：文件上传（multer）/
 * 聊天附件上传（图片 data URL + 路径暂存）/ 图片上传。
 */

import { Router } from "express";
import { promises as fsPromises } from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { authenticateToken } from "../middleware/auth.js";
import { extractProjectDirectory } from "../projects.js";
import { validatePathInProject } from "../services/filesystem.js";
import {
  CHAT_ATTACHMENT_IMAGE_MIMES,
  moveUploadedAttachment,
  normalizeUploadedFilename,
  sanitizeAttachmentFilename,
  uploadFilesHandler,
} from "../services/uploads.js";

const router = Router();

router.post("/api/projects/:projectName/files/upload", authenticateToken, uploadFilesHandler);

router.post("/api/projects/:projectName/upload-attachments", authenticateToken, async (req, res) => {
  let multerUpload;
  try {
    const multer = (await import("multer")).default;
    const uploadRoot = path.join(os.tmpdir(), "sati-chat-attachments", String(req.user.id));
    const storage = multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await fsPromises.mkdir(uploadRoot, { recursive: true });
          cb(null, uploadRoot);
        } catch (error) {
          cb(error);
        }
      },
      filename: (_req, file, cb) => {
        const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        file.originalname = normalizeUploadedFilename(file.originalname);
        cb(null, `${uniqueSuffix}-${sanitizeAttachmentFilename(file.originalname)}`);
      },
    });

    multerUpload = multer({
      storage,
      limits: {
        fileSize: 20 * 1024 * 1024,
        files: 10,
      },
    }).array("attachments", 10);
  } catch (error) {
    console.error("Error configuring attachment upload:", error);
    return res.status(500).json({ error: "Internal server error" });
  }

  multerUpload(req, res, async err => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "No attachments provided" });
    }

    let attachmentDir = null;
    try {
      const projectRoot = await extractProjectDirectory(req.params.projectName);
      const targetDir = path.join(
        projectRoot,
        ".tmp",
        "chat-attachments",
        `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      );
      const validation = validatePathInProject(projectRoot, targetDir);
      if (!validation.valid) {
        throw new Error(validation.error || "Invalid attachment target");
      }
      attachmentDir = validation.resolved;

      const images = [];
      const files = [];
      await fsPromises.mkdir(attachmentDir, { recursive: true });

      for (const [index, file] of req.files.entries()) {
        if (CHAT_ATTACHMENT_IMAGE_MIMES.has(file.mimetype)) {
          const buffer = await fsPromises.readFile(file.path);
          const storedFile = await moveUploadedAttachment(file, attachmentDir, index);
          images.push({
            name: storedFile.name,
            data: `data:${file.mimetype};base64,${buffer.toString("base64")}`,
            path: storedFile.path,
            size: storedFile.size,
            mimeType: storedFile.mimeType,
          });
          continue;
        }

        files.push(await moveUploadedAttachment(file, attachmentDir, index));
      }

      if (files.length === 0 && images.length === 0 && attachmentDir) {
        await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
      }

      res.json({ images, files });
    } catch (error) {
      console.error("Error processing attachments:", error);
      await Promise.all((req.files || []).map(file => fsPromises.unlink(file.path).catch(() => {})));
      if (attachmentDir) {
        await fsPromises.rm(attachmentDir, { recursive: true, force: true }).catch(() => {});
      }
      res.status(500).json({ error: "Failed to process attachments" });
    }
  });
});

// Image upload endpoint
router.post("/api/projects/:projectName/upload-images", authenticateToken, async (req, res) => {
  try {
    const multer = (await import("multer")).default;
    const path = (await import("path")).default;
    const fs = (await import("fs")).promises;
    const os = (await import("os")).default;

    // Configure multer for image uploads
    const storage = multer.diskStorage({
      destination: async (req, file, cb) => {
        const uploadDir = path.join(os.tmpdir(), "sati-image-uploads", String(req.user.id));
        await fs.mkdir(uploadDir, { recursive: true });
        cb(null, uploadDir);
      },
      filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
        const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, "_");
        cb(null, uniqueSuffix + "-" + sanitizedName);
      },
    });

    const fileFilter = (req, file, cb) => {
      const allowedMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/svg+xml"];
      if (allowedMimes.includes(file.mimetype)) {
        cb(null, true);
      } else {
        cb(new Error("Invalid file type. Only JPEG, PNG, GIF, WebP, and SVG are allowed."));
      }
    };

    const upload = multer({
      storage,
      fileFilter,
      limits: {
        fileSize: 5 * 1024 * 1024, // 5MB
        files: 5,
      },
    });

    // Handle multipart form data
    upload.array("images", 5)(req, res, async err => {
      if (err) {
        return res.status(400).json({ error: err.message });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ error: "No image files provided" });
      }

      try {
        // Process uploaded images
        const processedImages = await Promise.all(
          req.files.map(async file => {
            // Read file and convert to base64
            const buffer = await fs.readFile(file.path);
            const base64 = buffer.toString("base64");
            const mimeType = file.mimetype;

            // Clean up temp file immediately
            await fs.unlink(file.path);

            return {
              name: file.originalname,
              data: `data:${mimeType};base64,${base64}`,
              size: file.size,
              mimeType: mimeType,
            };
          }),
        );

        res.json({ images: processedImages });
      } catch (error) {
        console.error("Error processing images:", error);
        // Clean up any remaining files
        await Promise.all(req.files.map(f => fs.unlink(f.path).catch(() => {})));
        res.status(500).json({ error: "Failed to process images" });
      }
    });
  } catch (error) {
    console.error("Error in image upload endpoint:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Get token usage for a specific session

export default router;
