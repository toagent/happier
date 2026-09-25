import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { runScmCommand } from './runtime';

function initRepo(cwd: string): void {
    execFileSync('git', ['init'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd, stdio: 'pipe' });
    writeFileSync(join(cwd, 'a.txt'), 'a\n');
    execFileSync('git', ['add', 'a.txt'], { cwd, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'pipe' });
}

describe('runScmCommand output limits', () => {
    it('fails deterministically when command output exceeds configured limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-runtime-limit-'));
        initRepo(workspace);

        const result = await runScmCommand({
            bin: 'git',
            cwd: workspace,
            args: ['rev-parse', 'HEAD'],
            timeoutMs: 5000,
            maxOutputBytes: 8,
        });

        expect(result.success).toBe(false);
        expect(result.outputLimitExceeded).toBe(true);
        expect(result.stderr.toLowerCase()).toContain('output limit');
    });

    it('succeeds when output remains within configured limit', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-runtime-ok-'));
        initRepo(workspace);

        const result = await runScmCommand({
            bin: 'git',
            cwd: workspace,
            args: ['rev-parse', '--is-inside-work-tree'],
            timeoutMs: 5000,
            maxOutputBytes: 1024,
        });

        expect(result.success).toBe(true);
        expect(result.outputLimitExceeded).not.toBe(true);
        expect(result.stdout.trim()).toBe('true');
    });
});

describe('runScmCommand timeouts', () => {
    // A shell alias gives a deterministic slow git command without depending on repository size.
    const slowArgs = ['-c', 'alias.slow=!sleep 0.4', 'slow'];

    it('kills a command that outlives its timeout and reports it as timed out', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-runtime-timeout-'));
        initRepo(workspace);

        const result = await runScmCommand({ bin: 'git', cwd: workspace, args: slowArgs, timeoutMs: 100 });

        expect(result.success).toBe(false);
        expect(result.timedOut).toBe(true);
    });

    it('lets a bulk operation run to completion when the caller opts out of the timeout', async () => {
        // Whole-repository snapshots belong to an operation with its own lifecycle; the interactive
        // 15s default must not cut them off halfway.
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-runtime-no-timeout-'));
        initRepo(workspace);

        // Fast-forward well past the 15s interactive default while the real process is still running:
        // any timer the runtime scheduled fires and kills it.
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        try {
            const pending = runScmCommand({ bin: 'git', cwd: workspace, args: slowArgs, timeoutMs: null });
            vi.advanceTimersByTime(20_000);
            const result = await pending;

            expect(result.success).toBe(true);
            expect(result.timedOut).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});
