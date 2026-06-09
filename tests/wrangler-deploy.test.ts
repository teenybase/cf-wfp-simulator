/**
 * Verifies that `wrangler deploy --dispatch-namespace` works against the sim
 * with just `CLOUDFLARE_API_BASE_URL` redirected. No wrap, no patches.
 *
 * Most CF templates deploy tenants this way — wrangler handles the multipart
 * upload format. If this test passes, every wrangler-based deploy works.
 */

import { execSync, spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startSimulator, type RunningSimulator } from '../src/sim.js';
import { pickPort } from './_helpers.js';

let sim: RunningSimulator;
let tenantDir: string;

beforeAll(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wfp-deploy-'));
  sim = await startSimulator({ rootDir: path.join(root, '.sim'), port: await pickPort() });

  tenantDir = path.join(root, 'tenant');
  await mkdir(path.join(tenantDir, 'src'), { recursive: true });
  await writeFile(path.join(tenantDir, 'src', 'index.mjs'),
    `export default { fetch(req) { return new Response('tenant-deployed-via-wrangler at ' + new URL(req.url).pathname); } };`);
  await writeFile(path.join(tenantDir, 'wrangler.jsonc'), JSON.stringify({
    name: 'tenant-via-wrangler',
    main: 'src/index.mjs',
    compatibility_date: '2025-10-08',
  }, null, 2));
  await writeFile(path.join(tenantDir, 'package.json'), JSON.stringify({
    name: 'tenant', private: true, type: 'module', devDependencies: { wrangler: '^4.0.0' },
  }, null, 2));
  execSync('npm install --no-audit --no-fund --silent', { cwd: tenantDir, stdio: 'inherit' });
  try { execSync(`bash ${path.resolve(__dirname, '..', 'scripts', 'fix-alpine-workerd.sh')} ${tenantDir}`, { stdio: 'pipe' }); } catch { /* not Alpine */ }
}, 180_000);

afterAll(async () => {
  if (sim) await sim.dispose();
  if (tenantDir) await rm(path.dirname(tenantDir), { recursive: true, force: true });
});

describe('wrangler deploy --dispatch-namespace against the sim', () => {
  it('deploys a tenant via real wrangler; sim records it in the namespace; dispatch works', async () => {
    const out = await new Promise<string>((resolve, reject) => {
      const p = spawn('npx', ['wrangler', 'deploy', '--dispatch-namespace', 'prod'], {
        cwd: tenantDir,
        env: {
          ...process.env,
          CLOUDFLARE_API_BASE_URL: sim.url,
          CLOUDFLARE_API_TOKEN: 'dev',
          CLOUDFLARE_ACCOUNT_ID: 'local',
          WRANGLER_SEND_METRICS: 'false',
          NO_COLOR: '1',
          CI: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const chunks: string[] = [];
      p.stdout.on('data', (b: Buffer) => chunks.push(b.toString()));
      p.stderr.on('data', (b: Buffer) => chunks.push(b.toString()));
      const t = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`wrangler deploy timed out\n${chunks.join('')}`)); }, 25_000);
      p.on('exit', (code) => {
        clearTimeout(t);
        const out = chunks.join('');
        if (code !== 0) reject(new Error(`wrangler deploy exited ${code}\n${out}`));
        else resolve(out);
      });
      p.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    expect(out).toContain('Uploaded tenant-via-wrangler');
    expect(out).toContain('Dispatch Namespace: prod');

    // The sim lists the script in its namespace.
    const list = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts`).then(r => r.json());
    expect(list.success).toBe(true);
    expect(list.result.map((s: { id: string }) => s.id)).toContain('tenant-via-wrangler');

    // And requests dispatched through the wrap end up at this tenant.
    const r = await fetch(`${sim.url}/__wfp/dispatch/tenant-via-wrangler/hello/world`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('tenant-deployed-via-wrangler at /hello/world');
  }, 60_000);
});
