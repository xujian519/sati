import { describe, expect, it } from 'vitest';
import {
  getOpenUrlSpawnCommand,
  prepareBackgroundSpawnOptions,
  prepareCliSpawn,
  resolveWindowsCliCommand,
} from './processSpawn.js';

describe('process spawn helpers', () => {
  it('resolves Windows command shims without changing explicit executables', () => {
    expect(resolveWindowsCliCommand('npm', 'win32')).toBe('npm.cmd');
    expect(resolveWindowsCliCommand('npx', 'win32')).toBe('npx.cmd');
    expect(resolveWindowsCliCommand('which', 'win32')).toBe('where.exe');
    expect(resolveWindowsCliCommand('npm.cmd', 'win32')).toBe('npm.cmd');
    expect(resolveWindowsCliCommand('npm', 'darwin')).toBe('npm');
  });

  it('hides Windows CLI spawns and avoids shell shims', () => {
    const prepared = prepareCliSpawn('npx', ['task-master', 'init'], { shell: true }, 'win32');
    expect(prepared).toMatchObject({
      command: 'npx.cmd',
      args: ['task-master', 'init'],
      options: {
        shell: false,
        windowsHide: true,
      },
    });
  });

  it('keeps non-Windows background processes detached', () => {
    expect(prepareBackgroundSpawnOptions({ detached: true }, 'linux')).toMatchObject({
      detached: true,
    });
    expect(prepareBackgroundSpawnOptions({ detached: true }, 'win32')).toMatchObject({
      detached: false,
      windowsHide: true,
    });
  });

  it('uses platform-appropriate URL openers', () => {
    expect(getOpenUrlSpawnCommand('http://localhost:3000', 'win32')).toEqual({
      command: 'explorer.exe',
      args: ['http://localhost:3000'],
    });
    expect(getOpenUrlSpawnCommand('http://localhost:3000', 'darwin').command).toBe('open');
    expect(getOpenUrlSpawnCommand('http://localhost:3000', 'linux').command).toBe('xdg-open');
  });
});
