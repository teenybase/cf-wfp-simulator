/**
 * The real test: actual `wrangler dev` (subprocess) running a dispatcher worker
 * that imports `wfpDispatcher` from this package, with the sim running in the
 * background. Proves the full 2-tab flow works.
 *
 * NB: this test only runs if wrangler is installable; on CI it should pass on
 * Node 20+ with internet access (npx will fetch wrangler the first time).
 */

import type { ChildProcess } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSimulator, type RunningSimulator } from '../src/sim.js';
import { killProc, pickPort, spawnWranglerDev } from './_helpers.js';

const CF_WFP_SIM_PKG = path.resolve(__dirname, '..');

let sim: RunningSimulator;
let wrangler: ChildProcess | null = null;
let wranglerUrl: string;
let workdir: string;

beforeAll(async () => {
  workdir = await mkdtemp(path.join(tmpdir(), 'wfp-wrangler-'));
  await mkdir(path.join(workdir, 'src'), { recursive: true });

  sim = await startSimulator({ rootDir: path.join(workdir, '.wfp-local'), port: await pickPort() });

  // Write a tiny dispatcher that imports wfpDispatcher from this package.
  await writeFile(path.join(workdir, 'src', 'index.ts'), `
import { wfpDispatcher } from 'cf-wfp-simulator/wrap';

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/__healthz') return new Response('ok');
    const tenant = url.pathname.split('/')[1] || 'default';
    const dispatcher = wfpDispatcher(env);
    const stub = dispatcher.get(tenant);
    return stub.fetch(request);
  },
};
`);

  // wrangler.jsonc — note: NO dispatch_namespaces binding needed in dev.
  // The wrap function reads WFP_SIM_URL from vars and routes via HTTP.
  await writeFile(path.join(workdir, 'wrangler.jsonc'), JSON.stringify({
    $schema: 'node_modules/wrangler/config-schema.json',
    name: 'wfp-test-dispatcher',
    main: 'src/index.ts',
    compatibility_date: '2025-10-08',
    vars: { WFP_SIM_URL: sim.url },
  }, null, 2));

  // package.json that points 'cf-wfp-simulator' at the real package via file: link.
  await writeFile(path.join(workdir, 'package.json'), JSON.stringify({
    name: 'wfp-test-dispatcher',
    private: true,
    type: 'module',
    dependencies: {
      'cf-wfp-simulator': `file:${CF_WFP_SIM_PKG}`,
    },
    devDependencies: { wrangler: '^4.0.0' },
  }, null, 2));

  // Build cf-wfp-simulator first so the dist/ is available for import.
  const { execSync } = await import('node:child_process');
  execSync('npm run build', { cwd: CF_WFP_SIM_PKG, stdio: 'inherit' });

  // Install wrangler + the file:link in the temp project.
  execSync('npm install --no-audit --no-fund --silent', { cwd: workdir, stdio: 'inherit' });
  // Patch wrangler's workerd binary on Alpine (no-op on glibc).
  try {
    execSync(`bash ${path.resolve(__dirname, '..', 'scripts', 'fix-alpine-workerd.sh')} ${workdir}`, { stdio: 'pipe' });
  } catch { /* ignore if script missing */ }

  const w = await spawnWranglerDev({ cwd: workdir, readyUrl: '/__healthz', logLevel: 'warn' });
  wrangler = w.proc; wranglerUrl = w.url;
}, 180_000);

afterAll(async () => {
  await killProc(wrangler);
  if (sim) await sim.dispose();
  if (workdir) await rm(workdir, { recursive: true, force: true });
});

describe('real wrangler dev + cf-wfp-simulator (2-tab)', () => {
  it('dispatches a request through wrangler dev to a tenant deployed in the sim', async () => {
    await sim.deploy({
      namespace: 'production',
      scriptName: 'hello',
      mainModule: 'w.mjs',
      files: { 'w.mjs': "export default { fetch(req) { return new Response('hello from tenant at ' + new URL(req.url).pathname); } };" },
    });
    const r = await fetch(`${wranglerUrl}/hello/some/path`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hello from tenant at /hello/some/path');
  }, 30_000);

  it('returns "Worker not found." when the tenant does not exist', async () => {
    const r = await fetch(`${wranglerUrl}/no-such-tenant/`);
    // The dispatcher's wfpDispatcher throws; wrangler turns that into a 500.
    expect(r.status).toBe(500);
    expect(await r.text()).toContain('Worker not found');
  }, 30_000);
});
