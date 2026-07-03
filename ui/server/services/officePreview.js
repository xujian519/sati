import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
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

function getConfiguredLibreOfficeBinaryPath() {
  try {
    const record = readPilotDeckConfigFile();
    return String(record?.config?.webui?.officePreview?.binaryPath || '').trim();
  } catch (error) {
    console.warn('Failed to read LibreOffice binary path config; falling back to auto-detect:', error.message);
    return '';
  }
}

function uniqueCandidates(candidates) {
  return Array.from(new Set(candidates.map((candidate) => String(candidate || '').trim()).filter(Boolean)));
}

function getEnvironmentLibreOfficeCandidates() {
  return uniqueCandidates([
    process.env.LIBREOFFICE_PATH,
    process.env.SOFFICE_PATH,
  ]);
}

function readDirectoryNames(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function getMacLibreOfficeAppCandidates() {
  const appDirectories = [
    '/Applications',
    path.join(os.homedir(), 'Applications'),
  ];
  return appDirectories.flatMap((directoryPath) =>
    readDirectoryNames(directoryPath)
      .filter((name) => /^LibreOffice.*\.app$/i.test(name))
      .map((name) => path.join(directoryPath, name, 'Contents/MacOS/soffice')));
}

function getLinuxOptLibreOfficeCandidates() {
  return readDirectoryNames('/opt')
    .filter((name) => /^libreoffice/i.test(name))
    .map((name) => path.join('/opt', name, 'program/soffice'));
}

function getPlatformLibreOfficeCandidates() {
  const macCandidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    ...getMacLibreOfficeAppCandidates(),
  ];
  const linuxCandidates = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/usr/local/bin/libreoffice',
    '/snap/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
    ...getLinuxOptLibreOfficeCandidates(),
  ];
  const windowsCandidates = [
    'C:\\Program Files\\LibreOffice\\program\\soffice.exe',
    'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe',
  ];

  return process.platform === 'darwin'
    ? macCandidates
    : process.platform === 'win32'
      ? windowsCandidates
      : linuxCandidates;
}

function getPathLibreOfficeCandidates() {
  const pathCandidates = [
    'soffice',
    'libreoffice',
  ];
  return pathCandidates;
}

function getAutoLibreOfficeCandidates() {
  return uniqueCandidates([
    ...getEnvironmentLibreOfficeCandidates(),
    ...getPlatformLibreOfficeCandidates(),
    ...getPathLibreOfficeCandidates(),
  ]);
}

function getScannableLibreOfficeCandidates() {
  return uniqueCandidates([
    getConfiguredLibreOfficeBinaryPath(),
    ...getEnvironmentLibreOfficeCandidates(),
    ...getPlatformLibreOfficeCandidates(),
  ]);
}

function getLibreOfficeCandidates() {
  const configured = getConfiguredLibreOfficeBinaryPath();
  return configured ? [configured] : getAutoLibreOfficeCandidates();
}

async function probeLibreOfficeCandidate(candidate) {
  try {
    const result = await execFileAsync(candidate, ['--version'], {
      timeout: 5000,
      windowsHide: true,
    });
    return {
      binaryPath: candidate,
      available: true,
      version: String(result.stdout || result.stderr || '').trim(),
    };
  } catch (error) {
    return {
      binaryPath: candidate,
      available: false,
      version: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let libreOfficeStatusPromise = null;
let libreOfficeStatusCacheKey = '';
let libreOfficeCandidateStatusesPromise = null;
let libreOfficeCandidateStatusesCacheKey = '';

export async function getLibreOfficeStatus(options = {}) {
  const candidates = getLibreOfficeCandidates();
  const cacheKey = JSON.stringify(candidates);

  if (options.forceRefresh || cacheKey !== libreOfficeStatusCacheKey) {
    libreOfficeStatusPromise = null;
    libreOfficeStatusCacheKey = cacheKey;
  }

  if (!libreOfficeStatusPromise) {
    libreOfficeStatusPromise = (async () => {
      for (const candidate of candidates) {
        const result = await probeLibreOfficeCandidate(candidate);
        if (result.available) {
          return {
            available: true,
            binaryPath: result.binaryPath,
            version: result.version,
          };
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

export async function getLibreOfficeCandidateStatuses(options = {}) {
  const candidates = getScannableLibreOfficeCandidates();
  const cacheKey = JSON.stringify(candidates);

  if (options.forceRefresh || cacheKey !== libreOfficeCandidateStatusesCacheKey) {
    libreOfficeCandidateStatusesPromise = null;
    libreOfficeCandidateStatusesCacheKey = cacheKey;
  }

  if (!libreOfficeCandidateStatusesPromise) {
    libreOfficeCandidateStatusesPromise = Promise.all(
      candidates.map((candidate) => probeLibreOfficeCandidate(candidate)),
    );
  }

  return libreOfficeCandidateStatusesPromise;
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
