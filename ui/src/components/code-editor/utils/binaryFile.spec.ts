import { describe, expect, it } from 'vitest';
import { isBinaryFile, isOfficeFile } from './binaryFile';

describe('WPS Office file recognition', () => {
  it.each(['proposal.wps', 'budget.et', 'briefing.dps'])(
    'treats %s as an Office binary that uses converted preview',
    (fileName) => {
      expect(isOfficeFile(fileName)).toBe(true);
      expect(isBinaryFile(fileName)).toBe(true);
    },
  );
});
