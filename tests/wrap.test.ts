/**
 * Direct unit tests for the wrap function — no wrangler dev involved.
 * Proves the wrap correctly (a) routes to the sim's HTTP endpoint when
 * WFP_SIM_URL is set, (b) falls through to the real binding otherwise,
 * (c) surfaces "Worker not found." matching prod.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { wfpDispatcher } from '../src/wrap.js';
import { bootSim } from './_helpers.js';

describe('wfpDispatcher wrap', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('routes to the sim via HTTP when WFP_SIM_URL is set', async () => {
    const { sim, cleanup } = await bootSim();
    teardown = cleanup;
    await sim.deploy({
      namespace: 'production',
      scriptName: 'tenant-a',
      mainModule: 'w.mjs',
      files: { 'w.mjs': "export default { fetch(req) { return new Response('hi from ' + new URL(req.url).pathname); } };" },
    });

    const dispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url });
    const r = await dispatcher.get('tenant-a').fetch(new Request('https://app.example.com/some/path'));
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('hi from /some/path');
  });

  it('throws "Worker not found." (with period) for an unknown script — matches prod', async () => {
    const { sim, cleanup } = await bootSim();
    teardown = cleanup;
    const dispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url });
    await expect(
      dispatcher.get('does-not-exist').fetch(new Request('https://x/'))
    ).rejects.toThrow('Worker not found.');
  });

  it('falls through to env.dispatcher when WFP_SIM_URL is unset (prod path)', () => {
    const fakeBinding = {
      get(name: string) { return { fetch: async () => new Response(`prod:${name}`) }; },
    };
    const dispatcher = wfpDispatcher({ dispatcher: fakeBinding });
    expect(dispatcher).toBe(fakeBinding);
  });

  it('namespace isolation: same script name in two namespaces routes to the right one', async () => {
    const { sim, cleanup } = await bootSim();
    teardown = cleanup;
    // Deploy "shared" into BOTH staging and production with different responses.
    await sim.deploy({
      namespace: 'staging',
      scriptName: 'shared',
      mainModule: 'w.mjs',
      files: { 'w.mjs': "export default { fetch() { return new Response('staging'); } };" },
    });
    await sim.deploy({
      namespace: 'production',
      scriptName: 'shared',
      mainModule: 'w.mjs',
      files: { 'w.mjs': "export default { fetch() { return new Response('production'); } };" },
    });

    const stagingDispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url }, { namespace: 'staging' });
    const prodDispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url }, { namespace: 'production' });

    const a = await stagingDispatcher.get('shared').fetch(new Request('https://x/'));
    const b = await prodDispatcher.get('shared').fetch(new Request('https://x/'));

    expect(await a.text()).toBe('staging');
    expect(await b.text()).toBe('production');
  });

  it('namespace from env.WFP_NAMESPACE is honored', async () => {
    const { sim, cleanup } = await bootSim();
    teardown = cleanup;
    await sim.deploy({
      namespace: 'preview',
      scriptName: 'tenant-x',
      mainModule: 'w.mjs',
      files: { 'w.mjs': "export default { fetch() { return new Response('preview-tenant'); } };" },
    });
    const dispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url, WFP_NAMESPACE: 'preview' });
    const r = await dispatcher.get('tenant-x').fetch(new Request('https://x/'));
    expect(await r.text()).toBe('preview-tenant');
  });

  it('forwards request body and headers verbatim to the tenant', async () => {
    const { sim, cleanup } = await bootSim();
    teardown = cleanup;
    await sim.deploy({
      namespace: 'production',
      scriptName: 'echoer',
      mainModule: 'w.mjs',
      files: { 'w.mjs': `
        export default {
          async fetch(req) {
            const body = await req.text();
            return Response.json({
              method: req.method,
              auth: req.headers.get('authorization'),
              body,
            });
          },
        };
      ` },
    });
    const dispatcher = wfpDispatcher({ WFP_SIM_URL: sim.url });
    const r = await dispatcher.get('echoer').fetch(new Request('https://x/anything', {
      method: 'POST',
      headers: { authorization: 'Bearer secret', 'content-type': 'text/plain' },
      body: 'payload-body',
    }));
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ method: 'POST', auth: 'Bearer secret', body: 'payload-body' });
  });
});
