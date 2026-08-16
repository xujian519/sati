/**
 * ui/server 项目预览路由（B5-4 分片）。
 *
 * 从 ui/server/index.js 拆出（机械搬移，不改逻辑）：Office→PDF 预览 /
 * 电子表格 manifest/交互预览/单 sheet PDF / 项目根预览静态服务。
 */

import { Router } from "express";
import fs from "fs";
import { promises as fsPromises } from "fs";
import path from "path";
import { authenticateToken } from "../middleware/auth.js";
import {
  getConfiguredOfficePreviewService,
  getLibreOfficeCandidateStatuses,
  getLibreOfficeStatus,
  convertOfficeDocumentToPdf,
  OFFICE_PREVIEW_SERVICE_BUILTIN,
  OFFICE_PREVIEW_SERVICE_LIBREOFFICE,
} from "../services/officePreview.js";
import {
  getSpreadsheetInteractivePreview,
  getSpreadsheetPreviewManifest,
  getSpreadsheetSheetPreviewPdf,
  SPREADSHEET_PREVIEW_EXTENSIONS,
} from "../services/spreadsheetPreview.js";
import {
  OFFICE_PDF_PREVIEW_EXTENSIONS,
  getFileExtension,
  resolvePathInProject,
  setPreviewContentType,
  streamFileWithRange,
} from "../services/filesystem.js";
import { extractProjectDirectory } from "../projects.js";
import { getSplatPath } from "../utils/splatPath.js";
import { officePreviewPdfRateLimiter, officePreviewStatusRateLimiter } from "../services/rate-limit.js";

const router = Router();

router.get("/api/office-preview/status", authenticateToken, officePreviewStatusRateLimiter, async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
    const [libreOffice, candidates, service] = await Promise.all([
      getLibreOfficeStatus({ forceRefresh }),
      getLibreOfficeCandidateStatuses({ forceRefresh }),
      Promise.resolve(getConfiguredOfficePreviewService()),
    ]);
    res.json({
      service,
      libreOffice: {
        ...libreOffice,
        candidates,
      },
      supportedServices: [OFFICE_PREVIEW_SERVICE_BUILTIN, OFFICE_PREVIEW_SERVICE_LIBREOFFICE],
    });
  } catch (error) {
    console.error("Error reading Office preview status:", error);
    res.status(500).json({
      error: "Failed to read Office preview status",
      code: "OFFICE_PREVIEW_STATUS_FAILED",
    });
  }
});

// Convert Office files to PDF for lightweight read-only preview.
// This is an optional fallback for legacy Office/PPT formats; it only works
// when LibreOffice/soffice is available on the host.
router.get(
  "/api/projects/:projectName/files/preview/pdf",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

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
      const extension = getFileExtension(resolved);
      if (!OFFICE_PDF_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported Office preview format" });
      }

      const stats = await fsPromises.stat(resolved).catch(() => null);
      if (!stats?.isFile()) {
        return res.status(404).json({ error: "File not found" });
      }

      const officePreviewService = getConfiguredOfficePreviewService();
      if (officePreviewService !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "LibreOffice preview service is not selected",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }

      const pdfPath = await convertOfficeDocumentToPdf(resolved, { force, projectRoot });
      await streamFileWithRange(req, res, pdfPath, {
        mimeType: "application/pdf",
        cacheControl: "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
    } catch (error) {
      console.error("Error generating Office PDF preview:", error);
      if (!res.headersSent) {
        res.status(error.statusCode || 500).json({
          error:
            error.code === "LIBREOFFICE_NOT_FOUND"
              ? "LibreOffice executable not found"
              : error.code === "OFFICE_PREVIEW_DISABLED"
                ? "Office preview service is disabled"
                : "Failed to generate Office PDF preview",
          code: error.code || "OFFICE_PREVIEW_FAILED",
        });
      }
    }
  },
);

// Preserve workbook semantics for spreadsheet previews. The manifest exposes
// visible worksheet tabs, while each worksheet is rendered as its own PDF so
// multi-page sheets remain grouped under one tab in the UI.
router.get(
  "/api/projects/:projectName/files/preview/spreadsheet/manifest",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

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
      const extension = getFileExtension(resolvedResult.resolved);
      if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported spreadsheet preview format" });
      }
      if (extension !== "xlsx" && getConfiguredOfficePreviewService() !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "Legacy spreadsheet preview requires LibreOffice",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }
      const manifest = await getSpreadsheetPreviewManifest(resolvedResult.resolved, { force });
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.json(manifest);
    } catch (error) {
      console.error("Error reading spreadsheet preview manifest:", error);
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to read spreadsheet preview manifest",
        code: error.code || "SPREADSHEET_PREVIEW_MANIFEST_FAILED",
      });
    }
  },
);

router.get(
  "/api/projects/:projectName/files/preview/spreadsheet/data",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

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
      const extension = getFileExtension(resolvedResult.resolved);
      if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported spreadsheet preview format" });
      }
      if (extension !== "xlsx" && getConfiguredOfficePreviewService() !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "Legacy spreadsheet preview requires LibreOffice",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }

      const preview = await getSpreadsheetInteractivePreview(resolvedResult.resolved, { force });
      res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
      return res.json(preview);
    } catch (error) {
      console.error("Error generating interactive spreadsheet preview:", error);
      return res.status(error.statusCode || 500).json({
        error: error.message || "Failed to generate interactive spreadsheet preview",
        code: error.code || "SPREADSHEET_INTERACTIVE_PREVIEW_FAILED",
      });
    }
  },
);

router.get(
  "/api/projects/:projectName/files/preview/spreadsheet/sheet",
  authenticateToken,
  officePreviewPdfRateLimiter,
  async (req, res) => {
    try {
      const { projectName } = req.params;
      const { path: filePath, sheet: sheetIndex } = req.query;
      const force = req.query.force === "1" || req.query.force === "true";

      if (!filePath || sheetIndex === undefined) {
        return res.status(400).json({ error: "File path and worksheet index are required" });
      }

      const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
      if (!projectRoot) {
        return res.status(404).json({ error: "Project not found" });
      }
      const resolvedResult = resolvePathInProject(projectRoot, filePath);
      if (!resolvedResult.valid) {
        return res.status(403).json({ error: resolvedResult.error });
      }
      const extension = getFileExtension(resolvedResult.resolved);
      if (!SPREADSHEET_PREVIEW_EXTENSIONS.has(extension)) {
        return res.status(400).json({ error: "Unsupported spreadsheet preview format" });
      }
      const officePreviewService = getConfiguredOfficePreviewService();
      if (officePreviewService !== OFFICE_PREVIEW_SERVICE_LIBREOFFICE) {
        return res.status(409).json({
          error: "LibreOffice preview service is not selected",
          code: "LIBREOFFICE_PREVIEW_NOT_SELECTED",
        });
      }

      const pdfPath = await getSpreadsheetSheetPreviewPdf(resolvedResult.resolved, Number(sheetIndex), { force });
      await streamFileWithRange(req, res, pdfPath, {
        mimeType: "application/pdf",
        cacheControl: "no-store, no-cache, must-revalidate",
        pragma: "no-cache",
      });
    } catch (error) {
      console.error("Error generating worksheet PDF preview:", error);
      if (!res.headersSent) {
        res.status(error.statusCode || 500).json({
          error: error.message || "Failed to generate worksheet preview",
          code: error.code || "SPREADSHEET_SHEET_PREVIEW_FAILED",
        });
      }
    }
  },
);

// Serve project files through a stable project-root URL so generated HTML can
// load sibling CSS, JS and image assets with normal relative paths.
router.get("/api/projects/:projectName/preview/{*splat}", authenticateToken, async (req, res) => {
  try {
    const { projectName } = req.params;
    const relativeFilePath = getSplatPath(req) || "index.html";

    const projectRoot = await extractProjectDirectory(projectName).catch(() => null);
    if (!projectRoot) {
      return res.status(404).json({ error: "Project not found" });
    }

    const resolvedResult = resolvePathInProject(projectRoot, relativeFilePath);
    if (!resolvedResult.valid) {
      return res.status(403).json({ error: resolvedResult.error });
    }

    let resolved = resolvedResult.resolved;
    let stats = await fsPromises.stat(resolved).catch(() => null);
    if (stats?.isDirectory()) {
      resolved = path.join(resolved, "index.html");
      stats = await fsPromises.stat(resolved).catch(() => null);
    }

    if (!stats || !stats.isFile()) {
      return res.status(404).type("text/plain").send("Preview file not found.");
    }

    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    setPreviewContentType(res, resolved);
    fs.createReadStream(resolved).pipe(res);
  } catch (error) {
    console.error("Error serving project preview:", error);
    res.status(500).json({ error: error.message });
  }
});

// Download the complete project as a zip archive.

export default router;
