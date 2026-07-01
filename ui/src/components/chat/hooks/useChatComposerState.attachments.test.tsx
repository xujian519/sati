import { describe, expect, it } from 'vitest';
import { addAttachmentFiles } from './useChatComposerState';

function makeFile(name: string): File {
  return new File(['content'], name, { type: 'text/plain' });
}

describe('addAttachmentFiles', () => {
  it('keeps all files when a multi-file picker selection is under the limit', () => {
    const result = addAttachmentFiles([], [
      makeFile('one.txt'),
      makeFile('two.txt'),
      makeFile('three.txt'),
    ]);

    expect(result.files.map((file) => file.name)).toEqual([
      'one.txt',
      'two.txt',
      'three.txt',
    ]);
    expect(result.droppedCount).toBe(0);
  });

  it('keeps the first 10 files and reports skipped files when over the limit', () => {
    const existingFiles = Array.from({ length: 8 }, (_, index) => makeFile(`existing-${index}.txt`));
    const incomingFiles = Array.from({ length: 5 }, (_, index) => makeFile(`incoming-${index}.txt`));

    const result = addAttachmentFiles(existingFiles, incomingFiles);

    expect(result.files).toHaveLength(10);
    expect(result.files.map((file) => file.name)).toEqual([
      'existing-0.txt',
      'existing-1.txt',
      'existing-2.txt',
      'existing-3.txt',
      'existing-4.txt',
      'existing-5.txt',
      'existing-6.txt',
      'existing-7.txt',
      'incoming-0.txt',
      'incoming-1.txt',
    ]);
    expect(result.droppedCount).toBe(3);
  });
});
