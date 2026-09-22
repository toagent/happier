import { describe, expect, it } from 'vitest';

import { buildCodeServerReviewUrl } from './codeServerReviewUrl';

describe('buildCodeServerReviewUrl', () => {
  const target = {
    serverId: 'server-1',
    machineId: 'machine-1',
    baseUrl: 'https://review.example.test/ide/',
    rootPath: '/work/project',
  };

  it('opens the exact allowed session directory through the configured server', () => {
    expect(buildCodeServerReviewUrl({
      target,
      session: { serverId: 'server-1', machineId: 'machine-1', path: '/work/project/task #1' },
    })).toBe('https://review.example.test/ide/?folder=%2Fwork%2Fproject%2Ftask+%231');
  });

  it('refuses a different machine, server, sibling directory, or traversal', () => {
    for (const session of [
      { serverId: 'server-2', machineId: 'machine-1', path: '/work/project/task' },
      { serverId: 'server-1', machineId: 'machine-2', path: '/work/project/task' },
      { serverId: 'server-1', machineId: 'machine-1', path: '/work/project-sibling/task' },
      { serverId: 'server-1', machineId: 'machine-1', path: '/work/project/../private' },
      { serverId: 'server-1', machineId: 'machine-1', path: 'relative/task' },
    ]) {
      expect(buildCodeServerReviewUrl({ target, session })).toBeNull();
    }
  });

  it('refuses credentials and non-HTTPS code-server URLs', () => {
    for (const baseUrl of [
      'http://review.example.test/',
      'https://user:password@review.example.test/',
      'javascript:alert(1)',
      'https://review.example.test/?token=secret',
    ]) {
      expect(buildCodeServerReviewUrl({
        target: { ...target, baseUrl },
        session: { serverId: 'server-1', machineId: 'machine-1', path: '/work/project/task' },
      })).toBeNull();
    }
  });
});
