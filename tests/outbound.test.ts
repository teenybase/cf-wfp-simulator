/**
 * Outbound worker bridge tests. Verifies:
 *   - User worker fetch() is intercepted by the bridge → user-authored outbound
 *   - Per-call outbound params from `dispatcher.get(_, _, { outbound })` are
 *     projected onto the outbound's env via the AsyncLocalStorage wrapper
 *   - Allow-list filtering works (params not in `parameters[]` are dropped)
 *   - Outbound's own static bindings are preserved
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { wfpDispatcher } from '../src/wrap.js';
import { bootSim } from './_helpers.js';

async function bootSimWithOutbound(outboundSrc: string, opts: {
  parameters?: string[];
  bindings?: import('../src/types.js').Binding[];
} = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wfp-out-'));
  const outboundFile = path.join(dir, 'user-outbound.mjs');
  await writeFile(outboundFile, outboundSrc);
  return bootSim({
    outbounds: {
      production: { scriptPath: outboundFile, parameters: opts.parameters ?? [], bindings: opts.bindings ?? [] },
    },
  });
}

describe('Outbound worker bridge with ALS per-call params', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('intercepts user worker fetch() — outbound bridge handles it', async () => {
    const outbound = `
      export default {
        async fetch(req) {
          return Response.json({ interceptedUrl: req.url, method: req.method });
        },
      };
    `;
    const { sim, cleanup } = await bootSimWithOutbound(outbound);
    teardown = cleanup;

    await sim.deploy({
      namespace: 'production', scriptName: 'tenant', mainModule: 'w.mjs',
      files: { 'w.mjs': `
        export default {
          async fetch() {
            const r = await fetch('https://example.com/api?q=1');
            return new Response(await r.text());
          },
        };
      ` },
    });

    const r = await fetch(`${sim.url}/__wfp/dispatch/tenant/`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.interceptedUrl).toBe('https://example.com/api?q=1');
    expect(body.method).toBe('GET');
  });

  it('per-call outbound params from dispatcher.get(_, _, { outbound }) reach env via ALS', async () => {
    const outbound = `
      export default {
        async fetch(req, env) {
          return Response.json({
            customer_name: env.customer_name ?? null,
            secret_param: env.secret_param ?? null,
            static_key: env.STATIC_KEY ?? null,
          });
        },
      };
    `;
    const { sim, cleanup } = await bootSimWithOutbound(outbound, {
      // Allow customer_name; deliberately exclude secret_param to verify filtering.
      parameters: ['customer_name'],
      bindings: [{ type: 'plain_text', name: 'STATIC_KEY', text: 'sk-static' }],
    });
    teardown = cleanup;

    await sim.deploy({
      namespace: 'production', scriptName: 'tenant-x', mainModule: 'w.mjs',
      files: { 'w.mjs': `
        export default {
          async fetch() {
            const r = await fetch('https://example.com/');
            return new Response(await r.text());
          },
        };
      ` },
    });

    // Use the wrap to call the dispatcher with outbound params (mimics dispatcher code).
    const dispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url });
    const r = await dispatcher.get('tenant-x', undefined, {
      outbound: { customer_name: 'tenant-x', secret_param: 'should-be-dropped' },
    }).fetch(new Request('https://app/foo'));

    const body = await r.json();
    expect(body.customer_name).toBe('tenant-x');
    expect(body.secret_param).toBeNull(); // not in allow-list — dropped
    expect(body.static_key).toBe('sk-static'); // outbound's own binding flows through
  });

  it('outbound can deny based on URL', async () => {
    const outbound = `
      export default {
        async fetch(req) {
          if (new URL(req.url).hostname === 'blocked.example') {
            return new Response('denied', { status: 451 });
          }
          return new Response('allowed', { status: 200 });
        },
      };
    `;
    const { sim, cleanup } = await bootSimWithOutbound(outbound);
    teardown = cleanup;

    await sim.deploy({
      namespace: 'production', scriptName: 'a', mainModule: 'w.mjs',
      files: { 'w.mjs': `export default { async fetch() { const r = await fetch('https://blocked.example/'); return new Response(\`s=\${r.status}\`); } };` },
    });
    await sim.deploy({
      namespace: 'production', scriptName: 'b', mainModule: 'w.mjs',
      files: { 'w.mjs': `export default { async fetch() { const r = await fetch('https://allowed.example/'); return new Response(\`s=\${r.status}\`); } };` },
    });

    expect(await (await fetch(`${sim.url}/__wfp/dispatch/a/`)).text()).toBe('s=451');
    expect(await (await fetch(`${sim.url}/__wfp/dispatch/b/`)).text()).toBe('s=200');
  });
});
