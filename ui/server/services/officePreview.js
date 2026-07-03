import crypto from 'crypto';
import { execFile } from 'child_process';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { readPilotDeckConfigFile } from './pilotdeckConfig.js';

const execFileAsync = promisify(execFile);

export const OFFICE_PREVIEW_SERVICE_NONE = 'none';
export const OFFICE_PREVIEW_SERVICE_LIBREOFFICE = 'libreoffice';
export const OFFICE_PREVIEW_CACHE_DIR = path.join(os.tmpdir(), 'pilotdeck-office-preview-cache');
export const LIBREOFFICE_TIMEOUT_MS = Number(process.env.PILOTDECK_LIBREOFFICE_TIMEOUT_MS || 120000);

export function getConfiguredOfficePreviewService() {
  try {
    const record = readPilotDeckConfigFile();
    const configured = String(record?.config?.webui?.officePreview?.service || '').trim().toLowerCase();
    return configured === OFFICE_PREVIEW_SERVICE_NONE
      ? OFFICE_PREVIEW_SERVICE_NONE
      : OFFICE_PREVIEW_SERVICE_LIBREOFFICE;
  } catch (error) {
    console.warn('Failed to read Office preview service config; defaulting to LibreOffice:', error.message);
    return OFFICE_PREVIEW_SERVICE_LIBREOFFICE;
  }
}

function getLibreOfficeCandidates() {
  const explicit = [
    process.env.LIBREOFFICE_PATH,
    process.env.SOFFICE_PATH,
  ].filter(Boolean);

  return [
    ...explicit,
    'soffice',
    'libreoffice',
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];
}

let libreOfficeStatusPromise = null;

export async function getLibreOfficeStatus() {
  if (!libreOfficeStatusPromise) {
    libreOfficeStatusPromise = (async () => {
      for (const candidate of getLibreOfficeCandidates()) {
        try {
          const result = await execFileAsync(candidate, ['--version'], {
            timeout: 5000,
            windowsHide: true,
          });
          const version = String(result.stdout || result.stderr || '').trim();
          return {
            available: true,
            binaryPath: candidate,
            version,
          };
        } catch {
          // Try the next candidate.
        }
      }
      return {
        available: false,
        binaryPath: null,
        version: '',
      };
    })();
  }
  return libreOfficeStatusPromise;
}

async function getLibreOfficeBinary() {
  const status = await getLibreOfficeStatus();
  return status.available ? status.binaryPath : null;
}

export async function convertOfficeDocumentToPdf(sourcePath, options = {}) {
  const binary = await getLibreOfficeBinary();
  if (!binary) {
    const error = new Error('LibreOffice executable not found');
    error.statusCode = 501;
    error.code = 'LIBREOFFICE_NOT_FOUND';
    throw error;
  }

  const stats = await fsPromises.stat(sourcePath);
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${sourcePath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex');
  const cacheDir = path.join(OFFICE_PREVIEW_CACHE_DIR, cacheKey);
  const profileDir = path.join(cacheDir, 'profile');

  if (options.force) {
    await fsPromises.rm(cacheDir, { recursive: true, force: true }).catch(() => {});
  }

  await fsPromises.mkdir(cacheDir, { recursive: true });

  const cachedPdf = (await fsPromises.readdir(cacheDir).catch(() => []))
    .find((name) => name.toLowerCase().endsWith('.pdf'));
  if (cachedPdf) {
    return path.join(cacheDir, cachedPdf);
  }

  const args = [
    `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
    '--headless',
    '--nologo',
    '--nodefault',
    '--nolockcheck',
    '--nofirststartwizard',
    '--convert-to',
    'pdf',
    '--outdir',
    cacheDir,
    sourcePath,
  ];

  try {
    await execFileAsync(binary, args, {
      timeout: LIBREOFFICE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
  } catch (error) {
    error.statusCode = 500;
    error.code = error.code || 'LIBREOFFICE_CONVERT_FAILED';
    throw error;
  }

  const outputPdf = (await fsPromises.readdir(cacheDir))
    .find((name) => name.toLowerCase().endsWith('.pdf'));
  if (!outputPdf) {
    const error = new Error('LibreOffice did not produce a PDF preview');
    error.statusCode = 500;
    error.code = 'LIBREOFFICE_OUTPUT_MISSING';
    throw error;
  }

  return path.join(cacheDir, outputPdf);
}
