/**
 * Shared test infrastructure. Replaces ~6 copies of pickPort/waitFor and ~5
 * copies of bootSim that were duplicated across the suite.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { startSimulator, type RunningSimulator, type SimulatorOptions } from '../src/sim.js';

/** Bind to an ephemeral port and immediately release it. The OS picks one that's free now. */
export async function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      if (typeof a === 'object' && a) { const p = a.port; s.close(() => resolve(p)); }
      else { s.close(); reject(new Error('could not pick port')); }
    });
    s.on('error', reject);
  });
}

/** Poll `url` until it returns one of `expectedStatus`, or throw with logs. */
export async function waitForUrl(
  url: string,
  opts: { deadlineMs?: number; expectedStatus?: number[]; logs?: string[] } = {},
): Promise<void> {
  const deadlineMs = opts.deadlineMs ?? 30_000;
  const expected = opts.expectedStatus ?? [200];
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (expected.includes(r.status)) return;
    } catch { /* not ready */ }
    await new Promise(r => setTimeout(r, 250));
  }
  const logTail = opts.logs ? `\nlogs:\n${opts.logs.slice(-50).join('')}` : '';
  throw new Error(`url never became ready: ${url}${logTail}`);
}

/** Boot a sim against a fresh temp dir on a random port. Returns sim + cleanup. */
export async function bootSim(opts: Partial<SimulatorOptions> = {}): Promise<{
  sim: RunningSimulator;
  cleanup: () => Promise<void>;
}> {
  const root = await mkdtemp(path.join(tmpdir(), 'wfp-test-'));
  const port = await pickPort();
  const sim = await startSimulator({ rootDir: root, port, ...opts });
  return {
    sim,
    cleanup: async () => { await sim.dispose(); await rm(root, { recursive: true, force: true }); },
  };
}

/**
 * Spawn `wrangler dev` in `cwd` and wait for it to become ready. Returns the
 * subprocess + URL + a captured-log buffer for failure diagnostics.
 */
export async function spawnWranglerDev(opts: {
  cwd: string;
  /** A URL on the dispatcher that returns 200 once it's up (e.g. `/admin`, `/__healthz`). */
  readyUrl: string;
  port?: number;
  logLevel?: 'log' | 'warn' | 'debug' | 'info';
  deadlineMs?: number;
}): Promise<{ proc: ChildProcess; url: string; logs: string[] }> {
  const port = opts.port ?? await pickPort();
  const logs: string[] = [];
  const proc = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--log-level', opts.logLevel ?? 'log'], {
    cwd: opts.cwd,
    env: { ...process.env, NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false', CI: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout!.on('data', (b: Buffer) => logs.push(b.toString()));
  proc.stderr!.on('data', (b: Buffer) => logs.push(b.toString()));
  const url = `http://127.0.0.1:${port}`;
  await waitForUrl(url + opts.readyUrl, { deadlineMs: opts.deadlineMs ?? 90_000, logs });
  return { proc, url, logs };
}

/** Best-effort kill: SIGTERM, then SIGKILL after a short grace period. */
export async function killProc(proc: ChildProcess | null | undefined): Promise<void> {
  if (!proc || proc.killed) return;
  proc.kill('SIGTERM');
  await new Promise(r => setTimeout(r, 500));
  if (!proc.killed) proc.kill('SIGKILL');
}
