import { describe, expect, it } from 'vitest';
import {
  normalizeOfficePreviewService,
  normalizeSpreadsheetPreviewMode,
} from './officePreviewStatus';

describe('normalizeOfficePreviewService', () => {
  it('defaults missing and unknown values to disabled', () => {
    expect(normalizeOfficePreviewService(undefined)).toBe('none');
    expect(normalizeOfficePreviewService('unexpected')).toBe('none');
  });

  it('keeps an explicit LibreOffice selection', () => {
    expect(normalizeOfficePreviewService(' LibreOffice ')).toBe('libreoffice');
  });
});

describe('normalizeSpreadsheetPreviewMode', () => {
  it('defaults missing and unknown values to auto', () => {
    expect(normalizeSpreadsheetPreviewMode(undefined)).toBe('auto');
    expect(normalizeSpreadsheetPreviewMode('unexpected')).toBe('auto');
  });

  it('keeps explicit interactive and print selections', () => {
    expect(normalizeSpreadsheetPreviewMode(' Interactive ')).toBe('interactive');
    expect(normalizeSpreadsheetPreviewMode('PRINT')).toBe('print');
  });
});
