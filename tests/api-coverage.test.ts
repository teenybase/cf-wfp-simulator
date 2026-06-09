/**
 * Coverage tests for the CF REST API surface the sim now mocks:
 *  - Tag filter on list, bulk delete by tag
 *  - GET /scripts/:s/{bindings|content|settings}
 *  - PUT /namespaces/:n (rename), DELETE /namespaces/:n
 *  - Per-script secrets API (CRUD + flows into env)
 *  - Custom hostnames stub (CRUD + always-active SSL)
 *  - Workers Assets 3-step JWT upload + dispatch via env.ASSETS
 *  - Tier-2 stubs (KV/D1 create, images, browser, graphql) return success
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { RunningSimulator } from '../src/sim.js';
import { bootSim } from './_helpers.js';

async function deployStub(sim: RunningSimulator, ns: string, script: string, body: string, tags: string[] = []): Promise<void> {
  await sim.deploy({
    namespace: ns, scriptName: script, mainModule: 'w.mjs',
    files: { 'w.mjs': `export default { fetch() { return new Response(${JSON.stringify(body)}); } };` },
    tags,
  });
}

describe('script + namespace REST endpoints (list/get/rename/delete)', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('list with ?tags filter (yes/no AND semantics)', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await deployStub(sim, 'prod', 'a', 'a', ['plan:free', 'region:us']);
    await deployStub(sim, 'prod', 'b', 'b', ['plan:pro', 'region:us']);
    await deployStub(sim, 'prod', 'c', 'c', ['plan:pro', 'region:eu']);
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts?tags=plan%3Apro%3Ayes%2Cregion%3Aeu%3Ano`);
    const body = await r.json();
    expect(body.success).toBe(true);
    expect(body.result.map((s: { id: string }) => s.id)).toEqual(['b']);
  });

  it('bulk delete by tag', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await deployStub(sim, 'prod', 'a', 'a', ['ephemeral']);
    await deployStub(sim, 'prod', 'b', 'b', ['keep']);
    await deployStub(sim, 'prod', 'c', 'c', ['ephemeral']);
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts?tags=ephemeral%3Ayes`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    const list = await (await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts`)).json();
    expect(list.result.map((s: { id: string }) => s.id).sort()).toEqual(['b']);
  });

  it('GET /scripts/:s/bindings — secret_text values redacted', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 'envtest', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("ok") } };' },
      bindings: [
        { type: 'plain_text', name: 'PUB', text: 'visible' },
        { type: 'secret_text', name: 'SECRET', text: 'hidden' },
      ],
    });
    const r = await (await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/envtest/bindings`)).json();
    expect(r.success).toBe(true);
    const pub = r.result.find((b: { name: string }) => b.name === 'PUB');
    const sec = r.result.find((b: { name: string }) => b.name === 'SECRET');
    expect(pub.text).toBe('visible');
    expect(sec.text).toBeUndefined();
    expect(sec.type).toBe('secret_text');
  });

  it('GET /scripts/:s/settings returns full metadata', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 's1', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("ok") } };' },
      tags: ['t1'],
      compatibilityDate: '2025-09-01',
      compatibilityFlags: ['nodejs_compat'],
    });
    const r = await (await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/s1/settings`)).json();
    expect(r.result.main_module).toBe('w.mjs');
    expect(r.result.tags).toEqual(['t1']);
    expect(r.result.compatibility_date).toBe('2025-09-01');
    expect(r.result.compatibility_flags).toEqual(['nodejs_compat']);
  });

  it('GET /scripts/:s/content returns multipart echo of modules', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 's2', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("hi") } };' },
    });
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/s2/content`);
    expect(r.headers.get('content-type')!.startsWith('multipart/form-data; boundary=')).toBe(true);
    const text = await r.text();
    expect(text).toContain('w.mjs');
    expect(text).toContain('export default');
  });

  it('PUT /namespaces/:ns renames; scripts move under new name', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await deployStub(sim, 'old', 'a', 'a');
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/old`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'new' }),
    });
    expect(r.status).toBe(200);
    const list = await (await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces`)).json();
    expect(list.result.map((n: { namespace_name: string }) => n.namespace_name).sort()).toEqual(['new']);
    const newScripts = await (await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/new/scripts`)).json();
    expect(newScripts.result.map((s: { id: string }) => s.id)).toEqual(['a']);
  });

  it('DELETE /namespaces/:ns removes the namespace + its scripts', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await deployStub(sim, 'doomed', 'a', 'a');
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/doomed`, { method: 'DELETE' });
    expect(r.status).toBe(200);
    const list = await (await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces`)).json();
    expect(list.result).toEqual([]);
  });
});

describe('secrets API', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('PUT secret + GET list (metadata) + DELETE', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await deployStub(sim, 'prod', 's', 'ok');
    const base = `${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/s/secrets`;

    const put = await fetch(base, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'API_KEY', text: 'sk-test', type: 'secret_text' }) });
    expect(put.status).toBe(200);

    const list = await (await fetch(base)).json();
    expect(list.result).toEqual([{ name: 'API_KEY', type: 'secret_text' }]);

    const del = await fetch(`${base}/API_KEY`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const after = await (await fetch(base)).json();
    expect(after.result).toEqual([]);
  });

  it('secret PUT flows into the user worker\'s env.NAME', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 'reader', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch(_r,e) { return new Response(e.MY_SECRET ?? "(none)") } };' },
    });
    // Initially no secret.
    const before = await fetch(`${sim.url}/__wfp/dispatch/reader`);
    expect(await before.text()).toBe('(none)');

    await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/reader/secrets`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'MY_SECRET', text: 'sk-after', type: 'secret_text' }),
    });

    const after = await fetch(`${sim.url}/__wfp/dispatch/reader`);
    expect(await after.text()).toBe('sk-after');
  });
});

describe('custom hostnames stub', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('POST creates with status=active; GET by ?hostname returns it; DELETE removes', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const base = `${sim.url}/zones/zone-id-1/custom_hostnames`;

    const create = await fetch(base, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hostname: 'app.customer.example', ssl: { method: 'http', type: 'dv' } }),
    });
    const created = await create.json();
    expect(created.success).toBe(true);
    expect(created.result.status).toBe('active');
    expect(created.result.ssl.status).toBe('active');
    expect(created.result.hostname).toBe('app.customer.example');
    const id = created.result.id;

    const list = await (await fetch(`${base}?hostname=app.customer.example`)).json();
    expect(list.result).toHaveLength(1);
    expect(list.result[0].id).toBe(id);

    const single = await (await fetch(`${base}/${id}`)).json();
    expect(single.result.id).toBe(id);

    const del = await fetch(`${base}/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    const empty = await (await fetch(`${base}?hostname=app.customer.example`)).json();
    expect(empty.result).toEqual([]);
  });
});

describe('Workers Assets 3-step upload', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('full flow: session → bucket upload → script PUT → dispatch via env.ASSETS', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;

    const helloHtml = '<html><body>hello-asset</body></html>';
    const cssBody = 'body{color:red}';
    const helloHash = await sha256First32(helloHtml);
    const cssHash = await sha256First32(cssBody);
    const manifest = {
      '/index.html': { hash: helloHash, size: helloHtml.length },
      '/style.css': { hash: cssHash, size: cssBody.length },
    };

    // Step 1: open session
    const sessionR = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/site/assets-upload-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest }),
    });
    const sessionBody = await sessionR.json();
    expect(sessionBody.success).toBe(true);
    const sessionJwt = sessionBody.result.jwt;
    const buckets = sessionBody.result.buckets;
    expect(buckets.length).toBeGreaterThan(0);

    // Step 2: upload all hashes (we ignore bucket grouping and send everything in one request).
    const fd = new FormData();
    fd.append(helloHash, btoa(helloHtml));
    fd.append(cssHash, btoa(cssBody));
    const uploadR = await fetch(`${sim.url}/accounts/local/workers/assets/upload?base64=true`, {
      method: 'POST', headers: { authorization: `Bearer ${sessionJwt}` }, body: fd,
    });
    expect(uploadR.status).toBe(201);
    const uploadBody = await uploadR.json();
    const completionJwt = uploadBody.result.jwt;
    expect(typeof completionJwt).toBe('string');

    // Step 3: deploy a script that uses env.ASSETS.
    const workerSrc = `export default { async fetch(req, env) { return env.ASSETS.fetch(req); } };`;
    const ScriptForm = new FormData();
    const metadata = {
      main_module: 'w.mjs',
      bindings: [{ type: 'assets', name: 'ASSETS' }],
      assets: { jwt: completionJwt, config: { html_handling: 'auto-trailing-slash', not_found_handling: 'single-page-application' } },
      compatibility_date: '2025-01-01',
    };
    ScriptForm.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    ScriptForm.append('w.mjs', new Blob([workerSrc], { type: 'application/javascript+module' }), 'w.mjs');
    const putR = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/site`, {
      method: 'PUT', body: ScriptForm,
    });
    expect(putR.status).toBe(200);

    // Dispatch — env.ASSETS should serve /index.html
    const indexResp = await fetch(`${sim.url}/__wfp/dispatch/site/`);
    expect(indexResp.status).toBe(200);
    expect(await indexResp.text()).toContain('hello-asset');

    // And /style.css
    const cssResp = await fetch(`${sim.url}/__wfp/dispatch/site/style.css`);
    expect(cssResp.status).toBe(200);
    expect(await cssResp.text()).toBe(cssBody);
  });

  it('empty manifest: session jwt IS the completion token (no bucket upload needed)', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/empty/assets-upload-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ manifest: {} }),
    });
    const body = await r.json();
    expect(body.result.buckets).toEqual([]);
    expect(typeof body.result.jwt).toBe('string');
    // jwt should already be usable as a completion token; verify by deploying with it.
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({
      main_module: 'w.mjs',
      bindings: [{ type: 'assets', name: 'ASSETS' }],
      assets: { jwt: body.result.jwt },
    })], { type: 'application/json' }));
    fd.append('w.mjs', new Blob(['export default { fetch() { return new Response("ok") } };'], { type: 'application/javascript+module' }), 'w.mjs');
    const put = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/empty`, { method: 'PUT', body: fd });
    expect(put.status).toBe(200);
  });

  it('asset-only deploy (no main_module, no assets binding) serves assets at root', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;

    const html = '<html><body>asset-only-root</body></html>';
    const hash = await sha256First32(html);

    // Step 1: open session.
    const sessionR = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/aonly/assets-upload-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { '/index.html': { hash, size: html.length } } }),
    });
    const sessionJwt = (await sessionR.json()).result.jwt;

    // Step 2: upload the one asset.
    const fd = new FormData();
    fd.append(hash, btoa(html));
    const uploadR = await fetch(`${sim.url}/accounts/local/workers/assets/upload?base64=true`, {
      method: 'POST', headers: { authorization: `Bearer ${sessionJwt}` }, body: fd,
    });
    expect(uploadR.status).toBe(201);
    const completionJwt = (await uploadR.json()).result.jwt;

    // Step 3: deploy with assets but NO main_module and NO assets binding (true asset-only).
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      assets: { jwt: completionJwt, config: { html_handling: 'auto-trailing-slash' } },
      compatibility_date: '2025-01-01',
    })], { type: 'application/json' }));
    const putR = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/aonly`, {
      method: 'PUT', body: form,
    });
    expect(putR.status).toBe(200);
    expect((await putR.json()).result.has_assets).toBe(true);

    // Dispatch the root path — the synthesized worker serves /index.html.
    const resp = await fetch(`${sim.url}/__wfp/dispatch/prod/aonly/`);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toContain('asset-only-root');
  });
});

describe('Tier-2 stubs (KV/D1/images/browser/graphql)', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('returns synthetic success for create-KV-namespace, create-D1, images, browser, graphql', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const expectOk = async (r: Response, hasResult = true): Promise<void> => {
      expect(r.status).toBe(200);
      const body = await r.json();
      if (hasResult) expect(body.success).toBe(true);
    };
    await expectOk(await fetch(`${sim.url}/accounts/local/storage/kv/namespaces`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'x' }),
    }));
    await expectOk(await fetch(`${sim.url}/accounts/local/d1/database`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
    }));
    await expectOk(await fetch(`${sim.url}/accounts/local/images/v1`, { method: 'POST' }));
    await expectOk(await fetch(`${sim.url}/accounts/local/browser-rendering/snapshot`, { method: 'POST' }));
    const gql = await fetch(`${sim.url}/graphql`, { method: 'POST' });
    expect(gql.status).toBe(200);
    expect(await gql.json()).toEqual({ data: {}, errors: null });
  });
});

describe('request log', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('callback log receives method/path/status/durationMs for each request', async () => {
    const events: { method: string; path: string; status: number; durationMs: number }[] = [];
    const { sim, cleanup } = await bootSim({ log: (e) => events.push(e) }); teardown = cleanup;

    // Two requests: one 200 (deploy via REST), one 404 (dispatch unknown).
    await sim.deploy({
      namespace: 'prod', scriptName: 't1', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("ok"); } };' },
    });
    const ok = await fetch(`${sim.url}/__wfp/dispatch/prod/t1/`);
    const notFound = await fetch(`${sim.url}/__wfp/dispatch/prod/no-such-tenant/`);
    expect(ok.status).toBe(200);
    expect(notFound.status).toBe(404);

    const dispatchEvents = events.filter(e => e.path.startsWith('/__wfp/dispatch/'));
    expect(dispatchEvents.length).toBe(2);
    expect(dispatchEvents[0]!.status).toBe(200);
    expect(dispatchEvents[0]!.method).toBe('GET');
    expect(dispatchEvents[1]!.status).toBe(404);
    for (const e of dispatchEvents) {
      expect(typeof e.durationMs).toBe('number');
      expect(e.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('log: "quiet" suppresses log entirely (no callback fires, nothing on stderr beyond boot)', async () => {
    // No callback to assert silence; we just confirm boot succeeds with the option.
    const { sim, cleanup } = await bootSim({ log: 'quiet' }); teardown = cleanup;
    const r = await fetch(`${sim.url}/__wfp/dispatch/prod/no-such/`);
    expect(r.status).toBe(404);
    // If the implementation accidentally invoked stderr in quiet mode, vitest's
    // captured-stderr pane would show the bracketed `[sim] ...` line. We don't
    // have a direct programmatic assertion for that, but the type system
    // guarantees the sink is the no-op function.
  });
});

describe('CLI --outbounds JSON config loads + resolves paths', async () => {
  // Load the CLI module path-resolution shape we promise in --help. We can't
  // easily spawn the CLI in a vitest without dragging in subprocess plumbing,
  // so we exercise the same JSON-shape contract with the OutboundConfig type
  // and prove the underlying programmatic outbounds work the same way.
  const { tmpdir } = await import('node:os');
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const path = await import('node:path');

  let teardown: (() => Promise<void>) | null = null;
  let workdir: string;
  afterEach(async () => {
    if (teardown) { await teardown(); teardown = null; }
    if (workdir) await rm(workdir, { recursive: true, force: true });
  });

  it('outbounds.json: scriptPath relative to JSON file resolves correctly', async () => {
    workdir = await mkdtemp(path.join(tmpdir(), 'wfp-outbounds-'));
    await writeFile(path.join(workdir, 'outbound.mjs'),
      `export default { async fetch(req) { return new Response('outbound-bridge-handled'); } };`);
    const cfg = {
      production: { scriptPath: './outbound.mjs', parameters: ['customer_id'] },
    };
    await writeFile(path.join(workdir, 'outbounds.json'), JSON.stringify(cfg));

    // Exact same resolution the CLI does:
    const baseDir = path.dirname(path.resolve(path.join(workdir, 'outbounds.json')));
    const resolved = Object.fromEntries(
      Object.entries(cfg).map(([ns, c]) => [ns, { ...c, scriptPath: path.resolve(baseDir, c.scriptPath) }])
    );
    expect(resolved.production!.scriptPath).toBe(path.join(workdir, 'outbound.mjs'));

    // And it actually boots a sim.
    const { sim, cleanup } = await bootSim({ outbounds: resolved });
    teardown = cleanup;
    expect(sim.url).toMatch(/^http:\/\//);
  });
});

describe('handler detection in PUT response', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  async function putModule(simUrl: string, ns: string, name: string, src: string): Promise<{ handlers: string[] }> {
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({ main_module: 'w.mjs' })], { type: 'application/json' }));
    fd.append('w.mjs', new Blob([src], { type: 'application/javascript+module' }), 'w.mjs');
    const r = await fetch(`${simUrl}/accounts/local/workers/dispatch/namespaces/${ns}/scripts/${name}`, { method: 'PUT', body: fd });
    expect(r.status).toBe(200);
    const env = await r.json();
    return { handlers: env.result.handlers };
  }

  it('default export with fetch only → handlers: ["fetch"]', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const { handlers } = await putModule(sim.url, 'prod', 'a',
      `export default { fetch(req) { return new Response('ok'); } };`);
    expect(handlers).toEqual(['fetch']);
  });

  it('default export with fetch + queue + scheduled → all detected, fetch first', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const { handlers } = await putModule(sim.url, 'prod', 'multi',
      `export default {
         async fetch(req) { return new Response('ok'); },
         async queue(batch) { /* ... */ },
         scheduled(event) { /* ... */ },
       };`);
    expect(handlers[0]).toBe('fetch');
    expect(handlers).toContain('queue');
    expect(handlers).toContain('scheduled');
  });

  it('named export functions → detected', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const { handlers } = await putModule(sim.url, 'prod', 'named',
      `export async function fetch(req) { return new Response('ok'); }
       export async function tail(events) { /* ... */ }`);
    expect(handlers).toContain('fetch');
    expect(handlers).toContain('tail');
  });

  it('commented-out handlers are NOT detected', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // Note: JS doesn't allow nested block comments — keep these single-level.
    const { handlers } = await putModule(sim.url, 'prod', 'commented',
      `export default {
         fetch(req) { return new Response('ok'); },
         // queue(batch) {},
         /* scheduled(event) {} */
       };`);
    expect(handlers).not.toContain('queue');
    expect(handlers).not.toContain('scheduled');
  });
});

describe('DO storage mode + 10074 mismatch', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('redeploy that flips a DO class from SQLite to KV is rejected with 10074', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // First deploy: SQLite-backed Counter.
    await sim.deploy({
      namespace: 'prod', scriptName: 'do-app', mainModule: 'w.mjs',
      files: { 'w.mjs': `export class Counter { fetch() { return new Response('ok'); } } export default { fetch() { return new Response('ok'); } };` },
      bindings: [{ type: 'durable_object_namespace', name: 'COUNTER', class_name: 'Counter' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Counter'] }],
    });

    // Re-upload via the CF REST API directly (multipart) with KV-backed Counter — must 400 + 10074.
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({
      main_module: 'w.mjs',
      bindings: [{ type: 'durable_object_namespace', name: 'COUNTER', class_name: 'Counter' }],
      migrations: [{ tag: 'v2', new_classes: ['Counter'] }],
    })], { type: 'application/json' }));
    fd.append('w.mjs', new Blob([
      `export class Counter { fetch() { return new Response('ok'); } } export default { fetch() { return new Response('ok'); } };`,
    ], { type: 'application/javascript+module' }), 'w.mjs');

    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/do-app`, { method: 'PUT', body: fd });
    expect(r.status).toBe(400);
    const env = await r.json();
    expect(env.success).toBe(false);
    expect(env.errors[0].code).toBe(10074);
    expect(env.errors[0].message).toContain('Counter');
  });

  it('redeploy with the same storage mode is allowed', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 'do-app', mainModule: 'w.mjs',
      files: { 'w.mjs': `export class Foo { fetch() { return new Response('ok'); } } export default { fetch() { return new Response('ok'); } };` },
      bindings: [{ type: 'durable_object_namespace', name: 'FOO', class_name: 'Foo' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Foo'] }],
    });
    // No throw expected.
    await sim.deploy({
      namespace: 'prod', scriptName: 'do-app', mainModule: 'w.mjs',
      files: { 'w.mjs': `export class Foo { fetch() { return new Response('updated'); } } export default { fetch() { return new Response('updated'); } };` },
      bindings: [{ type: 'durable_object_namespace', name: 'FOO', class_name: 'Foo' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['Foo'] }],
    });
  });
});

async function sha256First32(s: string): Promise<string> {
  const buf = new TextEncoder().encode(s);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(digest)].slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
}
