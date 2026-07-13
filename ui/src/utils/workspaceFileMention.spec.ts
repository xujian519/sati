import { describe, expect, it } from 'vitest';
import {
  getWorkspaceRelativePath,
  insertWorkspaceFileMention,
} from './workspaceFileMention';

describe('getWorkspaceRelativePath', () => {
  it('returns a workspace-relative path for POSIX paths', () => {
    expect(getWorkspaceRelativePath(
      '/workspace/contracts/采购合同.docx',
      '/workspace',
    )).toBe('contracts/采购合同.docx');
  });

  it('normalizes Windows paths and compares drive paths case-insensitively', () => {
    expect(getWorkspaceRelativePath(
      'C:\\Work\\PilotDeck\\docs\\report.docx',
      'c:\\work\\pilotdeck',
    )).toBe('docs/report.docx');
  });

  it('rejects absolute paths outside the workspace', () => {
    expect(getWorkspaceRelativePath('/other/report.docx', '/workspace')).toBeNull();
  });

  it('supports a filesystem-root workspace without losing the file name', () => {
    expect(getWorkspaceRelativePath('/report.docx', '/')).toBe('report.docx');
  });

  it('rejects relative paths that escape the workspace', () => {
    expect(getWorkspaceRelativePath('../report.docx', '/workspace')).toBeNull();
  });
});

describe('insertWorkspaceFileMention', () => {
  it('inserts a mention into an empty composer', () => {
    expect(insertWorkspaceFileMention('', 'docs/report.docx', 0)).toEqual({
      input: 'docs/report.docx ',
      cursorPosition: 17,
      alreadyPresent: false,
    });
  });

  it('preserves readable spacing when inserting at the last cursor position', () => {
    expect(insertWorkspaceFileMention('Review please', 'docs/report.docx', 7)).toEqual({
      input: 'Review docs/report.docx please',
      cursorPosition: 24,
      alreadyPresent: false,
    });
  });

  it('does not insert the same path twice', () => {
    expect(insertWorkspaceFileMention('Review docs/report.docx please', 'docs/report.docx', 30)).toEqual({
      input: 'Review docs/report.docx please',
      cursorPosition: 30,
      alreadyPresent: true,
    });
  });
});
