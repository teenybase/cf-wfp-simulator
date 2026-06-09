/**
 * Regression tests for correctness + security issues found during code review.
 * Each describe block pins the behavior for one such fix so it can't regress.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { bootSim } from './_helpers.js';
import { DoStorageMismatchError, ValidationError } from '../src/sim.js';

describe('path traversal — rejects unsafe module + asset paths', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('rejects module file path containing ..', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await expect(sim.deploy({
      namespace: 'prod', scriptName: 'a', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default {fetch(){return new Response("ok")}}', '../escape.mjs': 'leak' },
    })).rejects.toThrow(ValidationError);
  });

  it('rejects absolute module file path', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await expect(sim.deploy({
      namespace: 'prod', scriptName: 'a', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default {fetch(){return new Response("ok")}}', '/etc/passwd': 'leak' },
    })).rejects.toThrow(ValidationError);
  });

  it('rejects unsafe namespace name', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await expect(sim.deploy({
      namespace: '../etc', scriptName: 'a', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default {fetch(){return new Response("ok")}}' },
    })).rejects.toThrow(ValidationError);
  });

  it('rejects unsafe script name', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await expect(sim.deploy({
      namespace: 'prod', scriptName: '..', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default {fetch(){return new Response("ok")}}' },
    })).rejects.toThrow(ValidationError);
  });

  it('REST API rejects unsafe script name (leading dot) with 400 + 10006', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // URL parsers normalize `..` away, so use a hidden-dotfile name that
    // survives URL normalization but is still rejected by isValidName.
    const fd = new FormData();
    fd.append('metadata', new Blob([JSON.stringify({ main_module: 'w.mjs' })], { type: 'application/json' }));
    fd.append('w.mjs', new Blob(['export default {fetch(){return new Response("ok")}}'], { type: 'application/javascript+module' }), 'w.mjs');
    const r = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/.bad`, { method: 'PUT', body: fd });
    expect(r.status).toBe(400);
    const env = await r.json();
    expect(env.errors[0].code).toBe(10006);
  });

  it('asset upload rejects bad-shaped hash field name', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // Start a session
    const sessionResp = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/x/assets-upload-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { '/index.html': { hash: '00000000000000000000000000000001', size: 5 } } }),
    });
    const session = (await sessionResp.json()).result;

    // Try to upload with an unsafe field name (path traversal)
    const fd = new FormData();
    fd.append('../escape', new Blob([new Uint8Array(5)]), 'x');
    const r = await fetch(`${sim.url}/accounts/local/workers/assets/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${session.jwt}` }, body: fd,
    });
    expect(r.status).toBe(400);
  });
});

describe('failed redeploy keeps the existing tenant intact', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('DO storage mismatch on redeploy: previous tenant still dispatches', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 't', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export class C { fetch() { return new Response("v1"); } } export default { fetch() { return new Response("v1-dispatch"); } };' },
      bindings: [{ type: 'durable_object_namespace', name: 'C', class_name: 'C' }],
      migrations: [{ tag: 'v1', new_sqlite_classes: ['C'] }],
    });
    // v1 alive
    const beforeR = await fetch(`${sim.url}/__wfp/dispatch/prod/t/`);
    expect(await beforeR.text()).toBe('v1-dispatch');

    // Attempt redeploy with mismatched storage mode — must reject
    await expect(sim.deploy({
      namespace: 'prod', scriptName: 't', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export class C { fetch() { return new Response("v2"); } } export default { fetch() { return new Response("v2-dispatch"); } };' },
      bindings: [{ type: 'durable_object_namespace', name: 'C', class_name: 'C' }],
      migrations: [{ tag: 'v2', new_classes: ['C'] }],
    })).rejects.toThrow(DoStorageMismatchError);

    // v1 must STILL dispatch — failed deploy must not destroy the previous tenant.
    const afterR = await fetch(`${sim.url}/__wfp/dispatch/prod/t/`);
    expect(afterR.status).toBe(200);
    expect(await afterR.text()).toBe('v1-dispatch');
  });

  it('bad asset token on redeploy: previous tenant still dispatches', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    await sim.deploy({
      namespace: 'prod', scriptName: 't', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("alive"); } };' },
    });

    // Redeploy referencing a JWT that doesn't exist
    await expect(sim.deploy({
      namespace: 'prod', scriptName: 't', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("dead"); } };' },
      assetsJwt: 'totally-fake-jwt-not-in-registry',
    })).rejects.toThrow(ValidationError);

    const r = await fetch(`${sim.url}/__wfp/dispatch/prod/t/`);
    expect(r.status).toBe(200);
    expect(await r.text()).toBe('alive');
  });
});

describe('explicit-namespace dispatch does not fall through to legacy lookup', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('seg1 is a known namespace + script missing → 404, no cross-namespace match', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // namespace `prod` exists.
    await sim.deploy({
      namespace: 'prod', scriptName: 'whatever', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("from-prod-whatever"); } };' },
    });
    // Another namespace contains a script literally named `prod`.
    await sim.deploy({
      namespace: 'staging', scriptName: 'prod', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch() { return new Response("BAD-CROSS-NAMESPACE"); } };' },
    });

    // Asking for prod/missing must NOT route to staging/prod.
    const r = await fetch(`${sim.url}/__wfp/dispatch/prod/missing/`);
    expect(r.status).toBe(404);
    const body = await r.text();
    expect(body).toBe('Worker not found.');
    expect(body).not.toContain('BAD-CROSS-NAMESPACE');
  });
});

describe('namespace delete cleans up secrets + on-disk files', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('delete + recreate does not leak old secrets', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // First incarnation
    await sim.deploy({
      namespace: 'tenant-ns', scriptName: 's', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch(req, env) { return new Response("v1: " + (env.SECRET ?? "<no-secret>")); } };' },
    });
    await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/tenant-ns/scripts/s/secrets`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'SECRET', text: 'OLD-SECRET-VALUE', type: 'secret_text' }),
    });

    // Delete the namespace entirely
    await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/tenant-ns`, { method: 'DELETE' });

    // Recreate same namespace + same script name (no secret this time)
    await sim.deploy({
      namespace: 'tenant-ns', scriptName: 's', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export default { fetch(req, env) { return new Response("v2: " + (env.SECRET ?? "<no-secret>")); } };' },
    });

    const r = await fetch(`${sim.url}/__wfp/dispatch/tenant-ns/s/`);
    expect(r.status).toBe(200);
    const body = await r.text();
    expect(body).toBe('v2: <no-secret>');
    expect(body).not.toContain('OLD-SECRET-VALUE');
  });
});

describe('DO storage mode flip rejected when first deploy omitted migrations', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('first deploy without migrations defaults to SQLite; later new_classes (KV) is rejected', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // First deploy: DO binding, no migrations → defaults to SQLite.
    await sim.deploy({
      namespace: 'prod', scriptName: 't', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export class C { fetch() { return new Response("v1"); } } export default { fetch() { return new Response("v1"); } };' },
      bindings: [{ type: 'durable_object_namespace', name: 'C', class_name: 'C' }],
    });

    // Second deploy: declare class C as KV-backed via new_classes. Must be rejected
    // because the effective old mode (sqlite by default) ≠ new mode (kv).
    await expect(sim.deploy({
      namespace: 'prod', scriptName: 't', mainModule: 'w.mjs',
      files: { 'w.mjs': 'export class C { fetch() { return new Response("v2"); } } export default { fetch() { return new Response("v2"); } };' },
      bindings: [{ type: 'durable_object_namespace', name: 'C', class_name: 'C' }],
      migrations: [{ tag: 'v1', new_classes: ['C'] }],
    })).rejects.toThrow(DoStorageMismatchError);
  });
});

describe('Workers Assets verifies uploaded hashes', () => {
  let teardown: (() => Promise<void>) | null = null;
  afterEach(async () => { if (teardown) { await teardown(); teardown = null; } });

  it('rejects upload whose content does not match declared hash', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    // Manifest declares hash "aabb...11" but we'll upload "differentbytes".
    const fakeHash = '0123456789abcdef0123456789abcdef';
    const sessionR = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/x/assets-upload-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { '/i.html': { hash: fakeHash, size: 5 } } }),
    });
    const session = (await sessionR.json()).result;

    // Upload bytes that don't hash to fakeHash
    const fd = new FormData();
    fd.append(fakeHash, new Blob(['hello']), 'i.html'); // sha256("hello").slice(0,32) != fakeHash
    const r = await fetch(`${sim.url}/accounts/local/workers/assets/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${session.jwt}` }, body: fd,
    });
    expect(r.status).toBe(400);
    const env = await r.json();
    expect(env.errors[0].message).toContain('mismatch');
  });

  it('rejects upload of hash not in session manifest', async () => {
    const { sim, cleanup } = await bootSim(); teardown = cleanup;
    const realHash = '00000000000000000000000000000001';
    const sessionR = await fetch(`${sim.url}/accounts/local/workers/dispatch/namespaces/prod/scripts/x/assets-upload-session`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ manifest: { '/i.html': { hash: realHash, size: 5 } } }),
    });
    const session = (await sessionR.json()).result;

    // Upload an extra hash not in the manifest
    const sneakyHash = 'deadbeefdeadbeefdeadbeefdeadbeef';
    const fd = new FormData();
    fd.append(sneakyHash, new Blob(['anything']), 'extra');
    const r = await fetch(`${sim.url}/accounts/local/workers/assets/upload`, {
      method: 'POST', headers: { authorization: `Bearer ${session.jwt}` }, body: fd,
    });
    expect(r.status).toBe(400);
    const env = await r.json();
    expect(env.errors[0].message).toContain('unknown asset hash');
  });
});

describe('WFPClient base URL normalization', () => {
  it('appends /client/v4 when base is api.cloudflare.com', async () => {
    const { WFPClient } = await import('../src/client.js');
    const client = new WFPClient({ base: 'https://api.cloudflare.com', token: 'x' });
    // Inspect via a fake fetch
    let called: string | null = null;
    const c2 = new WFPClient({ base: 'https://api.cloudflare.com', token: 'x', fetch: ((url: string) => {
      called = url;
      return Promise.resolve(new Response(JSON.stringify({ result: [], success: true, errors: [], messages: [] }), { headers: { 'content-type': 'application/json' } }));
    }) as typeof fetch });
    void client;
    return c2.list('production').then(() => {
      expect(called).toBe('https://api.cloudflare.com/client/v4/accounts/local/workers/dispatch/namespaces/production/scripts');
    });
  });
});
