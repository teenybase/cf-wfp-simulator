/**
 * Single-URL simulator. Hosts:
 *   - Tenant workers in Miniflare
 *   - Two HTTP endpoints on one port:
 *       (a) /__wfp/dispatch/<script>/<rest>  — the wrap function targets this
 *       (b) /accounts/<id>/workers/dispatch/namespaces/<ns>/scripts/<...>
 *           — CF REST API mock for script CRUD (so the user's "create tenant"
 *             code in their dispatcher works locally too)
 */

import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import Busboy from 'busboy';
import { Miniflare, type MiniflareOptions, type WorkerOptions } from 'miniflare';
import type { Binding, CFEnvelope, DurableObjectMigration, ScriptMetadata } from './types.js';
import { moduleContentType } from './internal/content-type.js';
import { HEADER_NOT_FOUND, HEADER_ORIGINAL_URL, HEADER_OUTBOUND, WFP_HEADER_PREFIX } from './internal/headers.js';
import { prepareOutbounds, renderWrapper, type PreparedOutbound } from './outbound.js';

export interface OutboundConfig {
  /** Path to user-authored outbound worker entry (.mjs/.js). */
  scriptPath: string;
  /** Allow-list of parameter names from `dispatcher.get(_, _, { outbound: {...} })`. */
  parameters?: string[];
  /** Static bindings on the outbound worker (KV/D1/secrets/etc.). */
  bindings?: Binding[];
}

export interface SimulatorOptions {
  /** Persist root + scripts dir. */
  rootDir?: string;
  /** Port the sim listens on. Wrap function and CF API both target this. */
  port?: number;
  host?: string;
  /** Names of dispatch namespaces to host (auto-created on first deploy if omitted). */
  namespaces?: string[];
  /** Per-namespace outbound worker config — restores prod-faithful outbound interception. */
  outbounds?: Record<string, OutboundConfig>;
  /** Bearer token to require on the CF API. Default: any. */
  authToken?: string;
  /**
   * Per-request logging mode.
   *   'pretty' (default) — one line per request to stderr with method/path/status/duration
   *   'quiet'            — suppress all per-request logging
   *   (event) => void    — receive each event as a structured object (for embedding in a host process)
   */
  log?: 'pretty' | 'quiet' | ((event: SimLogEvent) => void);
}

export interface SimLogEvent {
  method: string;
  path: string;
  status: number;
  durationMs: number;
}

export interface TenantDeployment {
  namespace: string;
  scriptName: string;
  /** Entry module specifier. Omit for asset-only deploys (set `assetsJwt`, no script). */
  mainModule?: string;
  files: Record<string, string | Uint8Array>;
  bindings?: Binding[];
  tags?: string[];
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  /** DO migrations — drives per-class SQLite vs KV storage mode. */
  migrations?: DurableObjectMigration[];
  /** Asset completion token from POST /assets-upload-session. */
  assetsJwt?: string;
  assetsConfig?: import('./types.js').AssetsConfig;
}

/** Thrown by deploy() when a redeploy attempts to flip a DO class between SQLite and KV. */
export class DoStorageMismatchError extends Error {
  constructor(public readonly className: string, public readonly oldMode: 'sqlite' | 'kv', public readonly newMode: 'sqlite' | 'kv') {
    super(`Durable Object class "${className}" cannot transition from ${oldMode}-backed to ${newMode}-backed storage. Use a fresh class name.`);
    this.name = 'DoStorageMismatchError';
  }
}

/** Thrown by deploy() when input fails validation (unsafe paths, invalid names, missing tokens). */
export class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

export interface RunningSimulator {
  url: string;
  miniflare: Miniflare;
  /** Programmatic deploy (useful for tests). */
  deploy(d: TenantDeployment): Promise<void>;
  remove(namespace: string, scriptName: string): Promise<void>;
  dispose(): Promise<void>;
}

interface ScriptRecord {
  metadata: ScriptMetadata;
  created_on: string;
  modified_on: string;
  etag: string;
}

// Cache derived DO storage modes per script record. Migrations are immutable
// once persisted; cache is invalidated automatically when deploy() replaces
// the record (new object reference ⇒ no entry in WeakMap).
const doModesCache = new WeakMap<ScriptRecord, Record<string, 'sqlite' | 'kv'>>();
function getDoStorageModes(rec: ScriptRecord): Record<string, 'sqlite' | 'kv'> {
  let m = doModesCache.get(rec);
  if (!m) { m = computeDoStorageModes(rec.metadata.migrations); doModesCache.set(rec, m); }
  return m;
}

interface HostnameRecord {
  id: string;
  zone_id: string;
  hostname: string;
  ssl_method: 'http' | 'txt' | 'email';
  ssl_type: 'dv';
  custom_metadata?: Record<string, string>;
  created_at: string;
}

interface Registry {
  namespaces: Record<string, { id: string; created_on: string }>;
  scripts: Record<string, Record<string, ScriptRecord>>;
  /** Per-script secrets: namespace → script → name → value. */
  secrets: Record<string, Record<string, Record<string, string>>>;
  /** Custom hostnames stub: zone_id → id → record. */
  hostnames: Record<string, Record<string, HostnameRecord>>;
  /** Assets manifests keyed by completion token. */
  assets: Record<string /* completionJwt */, AssetCompletion>;
}

/** Asset upload state. Stored in memory + persisted across restarts. */
interface AssetCompletion {
  /** Manifest path (with leading slash) → content hash. */
  manifest: Record<string, string>;
}

/** In-flight upload session. Held in memory only — resumes are not supported. */
interface AssetUploadSession {
  jwt: string;
  manifest: Record<string, string>;     // path → hash
  needed: Set<string>;                  // hashes still to upload
  createdAt: number;                    // ms — for TTL sweep on abandoned sessions
}

const ASSET_SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour

export async function startSimulator(opts: SimulatorOptions = {}): Promise<RunningSimulator> {
  const root = path.resolve(opts.rootDir ?? '.wfp-local');
  const scriptsDir = path.join(root, 'scripts');
  const persistRoot = path.join(root, 'persist');
  const assetsCasDir = path.join(root, 'assets-cas');
  const registryFile = path.join(root, 'registry.json');
  await fs.mkdir(scriptsDir, { recursive: true });
  await fs.mkdir(persistRoot, { recursive: true });
  await fs.mkdir(assetsCasDir, { recursive: true });

  // Default to 8788 so it doesn't collide with `wrangler dev`'s default 8787.
  const port = opts.port ?? 8788;
  const host = opts.host ?? '127.0.0.1';

  const registry: Registry = await loadRegistry(registryFile);
  for (const ns of opts.namespaces ?? []) {
    if (!registry.namespaces[ns]) {
      registry.namespaces[ns] = { id: randomUUID(), created_on: nowIso() };
      registry.scripts[ns] = registry.scripts[ns] ?? {};
    }
  }
  await saveRegistry(registryFile, registry);

  // GC stale staging dirs left by deploys interrupted by a process crash.
  // `.tmp-*` is always discardable. `.old-*` is the previous live worker; if
  // its `<script>` is missing, restore from the backup (deploy died between
  // the two renames); otherwise delete (deploy completed but rm raced).
  await Promise.all(Object.keys(registry.scripts).map(async (ns) => {
    const nsDir = path.join(scriptsDir, ns);
    let entries: string[] = [];
    try { entries = await fs.readdir(nsDir); } catch { return; }
    await Promise.all(entries.map(async (name) => {
      if (name.startsWith('.tmp-')) {
        await fs.rm(path.join(nsDir, name), { recursive: true, force: true }).catch(() => undefined);
        return;
      }
      const oldMatch = /^\.old-(.+)-[0-9a-f]{8}$/.exec(name);
      if (oldMatch) {
        const script = oldMatch[1]!;
        const live = path.join(nsDir, script);
        const backup = path.join(nsDir, name);
        const liveMissing = await fs.access(live).then(() => false, () => true);
        if (liveMissing) {
          await fs.rename(backup, live).catch(() => undefined);
        } else {
          await fs.rm(backup, { recursive: true, force: true }).catch(() => undefined);
        }
      }
    }));
  }));

  // Stage outbound workers: copy each user-authored outbound script into a
  // per-namespace dir alongside our generated bridge.mjs.
  const outboundsDir = path.join(root, 'outbound');
  const preparedOutbounds: PreparedOutbound[] = await prepareOutbounds(outboundsDir, opts.outbounds);

  const mf = new Miniflare(await buildMfConfig(registry, scriptsDir, persistRoot, preparedOutbounds));
  await mf.ready;

  // Mutation lock so concurrent uploads don't race on setOptions.
  let chain: Promise<unknown> = Promise.resolve();
  const withLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };

  const reconfigure = async () => mf.setOptions(await buildMfConfig(registry, scriptsDir, persistRoot, preparedOutbounds));

  async function deploy(d: TenantDeployment): Promise<void> {
    await withLock(async () => {
      // ── Phase 1: validation only. No fs writes yet — failure must leave the
      // previously deployed worker intact (rejected uploads must not destroy).

      if (!isValidName(d.namespace)) throw new ValidationError(`invalid namespace name: ${d.namespace}`);
      if (!isValidName(d.scriptName)) throw new ValidationError(`invalid script name: ${d.scriptName}`);
      // A deploy must carry either a script entry or an asset bundle (asset-only).
      if (!d.mainModule && !d.assetsJwt) {
        throw new ValidationError('deploy requires a mainModule, or assetsJwt for an asset-only deploy');
      }

      const finalDir = path.join(scriptsDir, d.namespace, d.scriptName);

      const fileEntries = Object.entries(d.files).sort(([a], [b]) => a.localeCompare(b));
      const fileBufs: { rel: string; buf: Buffer }[] = [];
      for (const [rel, content] of fileEntries) {
        // safeJoin's only role here is the validation; we use the returned
        // `rel` directly later via path.join(stagingDir, rel) — never re-derive.
        if (!safeJoin(finalDir, rel)) throw new ValidationError(`unsafe module path: ${rel}`);
        fileBufs.push({ rel, buf: typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content) });
      }

      type AssetDest = { rel: string; srcAbs: string; mp: string; hash: string };
      let assetPlan: { dests: AssetDest[] } | null = null;
      if (d.assetsJwt) {
        const completion = registry.assets[d.assetsJwt];
        if (!completion) throw new ValidationError(`unknown assets completion token: ${d.assetsJwt}`);
        const manifest = Object.entries(completion.manifest).sort(([a], [b]) => a.localeCompare(b));
        const dests: AssetDest[] = [];
        const assetsRoot = path.join(finalDir, '__assets');
        for (const [mp, hash] of manifest) {
          if (!isValidAssetHash(hash)) throw new ValidationError(`invalid asset hash: ${hash}`);
          const rel = mp.replace(/^\/+/, '');
          if (!safeJoin(assetsRoot, rel)) throw new ValidationError(`unsafe asset path: ${mp}`);
          dests.push({ rel, srcAbs: path.join(assetsCasDir, hash), mp, hash });
        }
        assetPlan = { dests };
      }

      // DO storage modes derived from bindings + migrations: a class with a DO
      // binding but no migration entry defaults to SQLite. Comparing both old
      // and new this way catches the "first deploy omitted migrations, second
      // deploy declares new_classes" mismatch that pure-migration comparison missed.
      const existing = registry.scripts[d.namespace]?.[d.scriptName];
      const oldModes = computeEffectiveDoModes(existing?.metadata.bindings ?? [], existing?.metadata.migrations);
      const newModes = computeEffectiveDoModes(d.bindings ?? [], d.migrations);
      for (const [cls, oldMode] of Object.entries(oldModes)) {
        const newMode = newModes[cls];
        if (newMode && newMode !== oldMode) throw new DoStorageMismatchError(cls, oldMode, newMode);
      }

      const h = createHash('sha256');
      for (const { rel, buf } of fileBufs) { h.update(rel); h.update('\0'); h.update(buf); h.update('\0'); }
      if (assetPlan) for (const { mp, hash } of assetPlan.dests) { h.update(mp); h.update('\0'); h.update(hash); h.update('\0'); }

      // ── Phase 2: stage to a sibling tmp dir, then atomically rename-swap.
      // tmp-* / old-* dir prefixes are GC'd at sim startup if a crash leaves them.

      const tmpDir = path.join(scriptsDir, d.namespace, `.tmp-${d.scriptName}-${randomUUID().slice(0, 8)}`);
      await fs.mkdir(tmpDir, { recursive: true });

      try {
        const dirsToMake = new Set(fileBufs.map(f => path.dirname(path.join(tmpDir, f.rel))));
        await Promise.all([...dirsToMake].map(d2 => fs.mkdir(d2, { recursive: true })));
        await Promise.all(fileBufs.map(f => fs.writeFile(path.join(tmpDir, f.rel), f.buf)));

        if (assetPlan) {
          const tmpAssetsDir = path.join(tmpDir, '__assets');
          await fs.mkdir(tmpAssetsDir, { recursive: true });
          const subDirs = new Set(assetPlan.dests.map(a => path.dirname(path.join(tmpAssetsDir, a.rel))).filter(d2 => d2 !== tmpAssetsDir));
          await Promise.all([...subDirs].map(d2 => fs.mkdir(d2, { recursive: true })));
          await Promise.all(assetPlan.dests.map(a => fs.copyFile(a.srcAbs, path.join(tmpAssetsDir, a.rel))));
        }

        // Atomic-ish swap: move live → backup, move tmp → live, then rm backup.
        const backupDir = path.join(scriptsDir, d.namespace, `.old-${d.scriptName}-${randomUUID().slice(0, 8)}`);
        let hadBackup = false;
        try {
          await fs.rename(finalDir, backupDir);
          hadBackup = true;
        } catch (e: unknown) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        await fs.mkdir(path.dirname(finalDir), { recursive: true });
        await fs.rename(tmpDir, finalDir);
        if (hadBackup) await fs.rm(backupDir, { recursive: true, force: true });
      } catch (e) {
        await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
        throw e;
      }

      // ── Phase 3: registry + Miniflare reconfigure.

      registry.namespaces[d.namespace] ??= { id: randomUUID(), created_on: nowIso() };
      registry.scripts[d.namespace] ??= {};
      const now = nowIso();
      registry.scripts[d.namespace]![d.scriptName] = {
        metadata: {
          main_module: d.mainModule,
          bindings: d.bindings ?? [],
          tags: d.tags ?? [],
          compatibility_date: d.compatibilityDate,
          compatibility_flags: d.compatibilityFlags,
          ...(d.migrations ? { migrations: d.migrations } : {}),
          ...(d.assetsJwt ? { assets: { jwt: d.assetsJwt, config: d.assetsConfig } } : {}),
        },
        created_on: existing?.created_on ?? now,
        modified_on: now,
        etag: h.digest('hex').slice(0, 32),
      };
      await saveRegistry(registryFile, registry);
      await reconfigure();
    });
  }

  async function remove(namespace: string, scriptName: string): Promise<void> {
    await withLock(async () => {
      delete registry.scripts[namespace]?.[scriptName];
      await fs.rm(path.join(scriptsDir, namespace, scriptName), { recursive: true, force: true });
      await saveRegistry(registryFile, registry);
      await reconfigure();
    });
  }

  const logSink: (e: SimLogEvent) => void =
    opts.log === 'quiet' ? () => {} :
    typeof opts.log === 'function' ? opts.log :
    (e) => process.stderr.write(`[sim] ${e.method} ${e.path} → ${e.status} (${e.durationMs}ms)\n`);

  const server = http.createServer((req, res) => {
    const start = Date.now();
    res.on('finish', () => logSink({
      method: req.method ?? 'UNKNOWN',
      path: req.url ?? '/',
      status: res.statusCode,
      durationMs: Date.now() - start,
    }));
    handleRequest(req, res, { mf, registry, scriptsDir, registryFile, paths: { assetsCasDir }, deploy, remove, withLock, reconfigure, authToken: opts.authToken })
      .catch(e => {
        if (!res.headersSent) {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end((e as Error).message);
        } else { try { res.end(); } catch { /* */ } }
      });
  });
  await new Promise<void>(r => server.listen(port, host, r));

  const url = `http://${host}:${port}`;
  console.log(`[cf-wfp-simulator] ${url}`);

  return {
    url, miniflare: mf, deploy, remove,
    dispose: async () => {
      await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve()));
      await mf.dispose();
    },
  };
}

// ───────── HTTP routing ─────────

interface HandlerCtx {
  mf: Miniflare;
  registry: Registry;
  scriptsDir: string;
  registryFile: string;
  paths: { assetsCasDir: string };
  deploy: (d: TenantDeployment) => Promise<void>;
  remove: (ns: string, s: string) => Promise<void>;
  withLock: <T>(fn: () => Promise<T>) => Promise<T>;
  reconfigure: () => Promise<void>;
  authToken: string | undefined;
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'x'}`);
  const cleanPath = url.pathname.replace(/^\/client\/v4/, '');

  // (a) Wrap-function dispatch. The asset case `/site/style.css` is ambiguous
  // (ns=site,script=style.css vs script=site,rest=/style.css), so resolveDispatch
  // tries new-form lookup first, falls back to old-form namespace search.
  if (url.pathname.startsWith('/__wfp/dispatch/')) {
    const resolved = resolveDispatch(url.pathname, ctx.registry);
    if (!resolved) {
      res.writeHead(404, { 'content-type': 'text/plain', [HEADER_NOT_FOUND]: '1' });
      res.end('Worker not found.');
      return;
    }
    return await handleDispatch(req, res, ctx, resolved, url.search);
  }

  // (b) Asset bucket upload — uses its own JWT bearer; bypass the CF API token check.
  if (req.method === 'POST' && /^\/accounts\/[^/]+\/workers\/assets\/upload$/.test(cleanPath)) {
    return handleAssetBucketUpload(req, res, ctx, url);
  }

  // (c) CF REST API mock: /accounts/<id>/workers/dispatch/namespaces/... and /zones/...
  if (ctx.authToken !== undefined) {
    const tok = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    if (tok !== ctx.authToken) return writeEnv(res, 401, errEnv(CFErrorCode.AUTH_INVALID, 'invalid bearer token'));
  }
  await handleApi(req, res, ctx, url);
}

/**
 * Parse `/__wfp/dispatch/<...>` and resolve to a known script.
 * Supports both `/<ns>/<script>/...` (new) and `/<script>/...` (old, namespace-search).
 *
 * If seg1 is a known namespace, ONLY use new-form interpretation — do not fall
 * through to legacy lookup, otherwise a missing script in an explicit namespace
 * could silently route to a script in another namespace whose name matches seg1.
 *
 * Returns null if no script matches — caller emits 404.
 */
function resolveDispatch(
  pathname: string,
  registry: Registry,
): { namespace: string; script: string; restPath: string } | null {
  const PREFIX = '/__wfp/dispatch/';
  const segments = pathname.slice(PREFIX.length).split('/');
  if (!segments[0]) return null;
  const seg1 = decodeURIComponent(segments[0]);

  // New-form: seg1 = namespace, seg2 = script. Look up exactly.
  // If seg1 is a known namespace, this is authoritative — no fallback to legacy.
  if (segments.length >= 2 && segments[1]) {
    const seg2 = decodeURIComponent(segments[1]);
    const nsScripts = registry.scripts[seg1];
    if (nsScripts) {
      if (nsScripts[seg2]) {
        return { namespace: seg1, script: seg2, restPath: '/' + segments.slice(2).join('/') };
      }
      // Known namespace, missing script — do NOT cross namespace boundaries.
      return null;
    }
  }

  // Legacy single-segment form: seg1 = script, search across namespaces.
  for (const [ns, scripts] of Object.entries(registry.scripts)) {
    if (scripts[seg1]) {
      const restPath = segments.length >= 2 ? '/' + segments.slice(1).join('/') : '/';
      return { namespace: ns, script: seg1, restPath };
    }
  }
  return null;
}

async function handleDispatch(
  req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx,
  resolved: { namespace: string; script: string; restPath: string },
  search: string,
): Promise<void> {
  const { namespace, script: scriptName, restPath } = resolved;

  // Reconstruct the original URL the dispatcher's user worker was targeting.
  const originalUrl = (req.headers[HEADER_ORIGINAL_URL] as string | undefined)
    ?? `http://${req.headers.host ?? 'sim'}${restPath}${search}`;

  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v !== 'string') continue;
    const lk = k.toLowerCase();
    if (lk.startsWith(WFP_HEADER_PREFIX)) continue; // strip wrap-control headers
    if (lk === 'host' || lk === 'connection') continue;
    headers.set(lk, v);
  }
  // Outbound params ride to the per-tenant ALS wrapper, which re-attaches them
  // to every outbound subrequest from the user worker.
  const outbound = req.headers[HEADER_OUTBOUND] as string | undefined;
  if (outbound) headers.set(HEADER_OUTBOUND, outbound);

  const body = (req.method !== 'GET' && req.method !== 'HEAD') ? Readable.toWeb(req) : null;
  const fetcher = (await ctx.mf.getWorker(workerName(namespace, scriptName))) as unknown as {
    fetch(input: string, init: { method: string; headers: Record<string, string>; body: unknown; duplex?: string; redirect?: string }): Promise<Response>;
  };
  const response = await fetcher.fetch(originalUrl, {
    method: req.method ?? 'GET',
    headers: headersToObj(headers),
    body: body as unknown,
    duplex: body ? 'half' : undefined,
    redirect: 'manual',
  });
  res.writeHead(response.status, headersToObj(response.headers));
  if (response.body) Readable.fromWeb(response.body as never).pipe(res);
  else res.end();
}

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx, url: URL): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  const urlPath = url.pathname.replace(/^\/client\/v4/, ''); // accept both bare and /client/v4 prefix

  // Custom hostnames (Cloudflare for SaaS) — short-circuit before WFP routes.
  const hostnamesCol = matchPath(urlPath, /^\/zones\/([^/]+)\/custom_hostnames\/?$/);
  const hostnameById = matchPath(urlPath, /^\/zones\/([^/]+)\/custom_hostnames\/([^/]+)$/);
  if (hostnamesCol) return handleCustomHostnames(req, res, ctx, url, method, hostnamesCol[1]!);
  if (hostnameById) return handleCustomHostnameById(req, res, ctx, method, hostnameById[1]!, hostnameById[2]!);

  // Workers Assets — start upload session.
  const assetsSession = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)\/assets-upload-session$/);
  if (assetsSession && method === 'POST') return handleAssetsUploadSession(req, res, ctx, assetsSession[1]!, assetsSession[2]!);

  // Convenience stubs for tier-2 endpoints (vibesdk + others poll these).
  // Return synthetic success so the template's startup checks don't 404-spam.
  const tier2 = handleTier2Stubs(req, res, ctx, urlPath, method, url);
  if (tier2) return;

  const ns = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces$/);
  const nsScoped = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)$/);
  const scriptsCol = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/?$/);
  const script = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/);
  const scriptSub = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)\/(bindings|content|settings)$/);
  const secrets = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)\/secrets\/?$/);
  const secretByName = matchPath(urlPath, /^\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)\/secrets\/([^/]+)$/);

  // /namespaces collection
  if (ns) {
    if (method === 'GET') {
      return writeEnv(res, 200, okEnv(Object.entries(ctx.registry.namespaces).map(([n, x]) => ({
        namespace_id: x.id, namespace_name: n, created_on: x.created_on,
        script_count: Object.keys(ctx.registry.scripts[n] ?? {}).length, trusted_workers: false,
      }))));
    }
    if (method === 'POST') {
      const body = await readJson(req) as { name?: string } | null;
      if (!body?.name) return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, 'missing name', { pointer: '/name' }));
      // Namespace names become on-disk directory segments — reject traversal/unsafe names.
      if (!isValidName(body.name)) return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, `invalid namespace name: ${body.name}`, { pointer: '/name' }));
      ctx.registry.namespaces[body.name] ??= { id: randomUUID(), created_on: nowIso() };
      ctx.registry.scripts[body.name] ??= {};
      await saveRegistry(ctx.registryFile, ctx.registry);
      return writeEnv(res, 200, okEnv({ namespace_name: body.name, namespace_id: ctx.registry.namespaces[body.name]!.id }));
    }
    return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /namespaces`));
  }

  // /namespaces/:ns
  if (nsScoped) {
    const name = nsScoped[1]!;
    if (method === 'GET') {
      const meta = ctx.registry.namespaces[name];
      if (!meta) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'namespace not found'));
      return writeEnv(res, 200, okEnv({
        namespace_id: meta.id, namespace_name: name, created_on: meta.created_on,
        script_count: Object.keys(ctx.registry.scripts[name] ?? {}).length, trusted_workers: false,
      }));
    }
    if (method === 'PUT') {
      const body = await readJson(req) as { name?: string } | null;
      if (!body?.name) return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, 'missing name (rename target)', { pointer: '/name' }));
      if (!isValidName(body.name)) return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, `invalid namespace name: ${body.name}`, { pointer: '/name' }));
      const newName = body.name;
      return await ctx.withLock(async () => {
        const meta = ctx.registry.namespaces[name];
        if (!meta) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'namespace not found'));
        if (newName !== name) {
          if (ctx.registry.namespaces[newName]) {
            return writeEnv(res, 409, errEnv(CFErrorCode.CONFLICT, `namespace '${newName}' already exists`));
          }
          ctx.registry.namespaces[newName] = meta;
          delete ctx.registry.namespaces[name];
          ctx.registry.scripts[newName] = ctx.registry.scripts[name] ?? {};
          delete ctx.registry.scripts[name];
          ctx.registry.secrets[newName] = ctx.registry.secrets[name] ?? {};
          delete ctx.registry.secrets[name];
          // ENOENT is fine (no scripts ever deployed); other errors must surface
          // so registry + disk don't drift silently.
          try {
            await fs.rename(path.join(ctx.scriptsDir, name), path.join(ctx.scriptsDir, newName));
          } catch (e: unknown) {
            if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
          }
          await saveRegistry(ctx.registryFile, ctx.registry);
          await ctx.reconfigure();
        }
        return writeEnv(res, 200, okEnv({ namespace_name: newName, namespace_id: meta.id, created_on: meta.created_on }));
      });
    }
    if (method === 'DELETE') {
      return await ctx.withLock(async () => {
        if (!ctx.registry.namespaces[name]) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'namespace not found'));
        delete ctx.registry.namespaces[name];
        delete ctx.registry.scripts[name];
        // Drop secrets so they don't bleed into a recreated-namespace's tenants.
        delete ctx.registry.secrets[name];
        await fs.rm(path.join(ctx.scriptsDir, name), { recursive: true, force: true }).catch(() => undefined);
        await saveRegistry(ctx.registryFile, ctx.registry);
        await ctx.reconfigure();
        return writeEnv(res, 200, okEnv({}));
      });
    }
    return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /namespaces/:ns`));
  }

  // /namespaces/:ns/scripts (collection: list with ?tags=, bulk delete by ?tags=)
  if (scriptsCol) {
    const ns2 = scriptsCol[1]!;
    if (!ctx.registry.namespaces[ns2]) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'namespace not found'));
    const tagsQ = url.searchParams.get('tags');
    let filter: ((tags: string[]) => boolean) | null = null;
    if (tagsQ) {
      try { filter = parseTagFilter(tagsQ); } catch (e) { return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, (e as Error).message)); }
    }
    if (method === 'GET') {
      const all = ctx.registry.scripts[ns2] ?? {};
      const result: { id: string; tags: string[]; created_on: string; modified_on: string; etag: string }[] = [];
      for (const [id, r] of Object.entries(all)) {
        if (filter && !filter(r.metadata.tags ?? [])) continue;
        result.push({ id, tags: r.metadata.tags ?? [], created_on: r.created_on, modified_on: r.modified_on, etag: r.etag });
      }
      return writeEnv(res, 200, okEnv(result));
    }
    if (method === 'DELETE') {
      if (!filter) return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, 'tags filter required for bulk delete', { pointer: '/tags' }));
      const all = ctx.registry.scripts[ns2] ?? {};
      const removed: string[] = [];
      for (const [id, r] of Object.entries(all)) {
        if (filter(r.metadata.tags ?? [])) { await ctx.remove(ns2, id); removed.push(id); }
      }
      return writeEnv(res, 200, okEnv({ removed }));
    }
    return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /scripts`));
  }

  // /namespaces/:ns/scripts/:s
  if (script) {
    const [, ns3, scr] = script;
    if (method === 'PUT') {
      const parsed = await parseUpload(req);
      const assetsJwt = parsed.metadata.assets?.jwt;
      if (assetsJwt && !ctx.registry.assets[assetsJwt]) {
        return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, 'metadata.assets.jwt does not match any completed asset upload session', { pointer: '/assets/jwt' }));
      }
      try {
        await ctx.deploy({
          namespace: ns3!, scriptName: scr!,
          mainModule: parsed.metadata.main_module ?? parsed.metadata.body_part,
          files: Object.fromEntries(parsed.modules.map(m => [m.name, m.buffer])),
          bindings: parsed.metadata.bindings ?? [],
          tags: parsed.metadata.tags ?? [],
          compatibilityDate: parsed.metadata.compatibility_date,
          compatibilityFlags: parsed.metadata.compatibility_flags,
          ...(parsed.metadata.migrations ? { migrations: parsed.metadata.migrations } : {}),
          ...(assetsJwt ? { assetsJwt, assetsConfig: parsed.metadata.assets?.config } : {}),
        });
      } catch (e) {
        if (e instanceof DoStorageMismatchError) {
          return writeEnv(res, 400, errEnv(CFErrorCode.DO_STORAGE_MISMATCH, e.message));
        }
        if (e instanceof ValidationError) {
          return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, e.message));
        }
        throw e;
      }
      const r = ctx.registry.scripts[ns3!]![scr!]!;
      const entryName = r.metadata.main_module ?? r.metadata.body_part;
      const entryModule = entryName ? parsed.modules.find(m => m.name === entryName) : undefined;
      const handlers = entryModule
        ? detectHandlers(entryModule.buffer.toString('utf8'))
        : ['fetch'];
      const hasAssets = !!r.metadata.assets;
      return writeEnv(res, 200, okEnv({
        id: scr, etag: r.etag, tag: r.etag, tags: r.metadata.tags ?? [],
        created_on: r.created_on, modified_on: r.modified_on,
        compatibility_date: r.metadata.compatibility_date,
        compatibility_flags: r.metadata.compatibility_flags ?? [],
        has_modules: true, has_assets: hasAssets, startup_time_ms: 0,
        handlers, named_handlers: [],
      }));
    }
    if (method === 'DELETE') {
      const existed = ctx.registry.scripts[ns3!]?.[scr!] !== undefined;
      if (!existed) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'script not found'));
      await ctx.remove(ns3!, scr!);
      return writeEnv(res, 200, okEnv({}));
    }
    if (method === 'GET') {
      const r = ctx.registry.scripts[ns3!]?.[scr!];
      if (!r) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'script not found'));
      return writeEnv(res, 200, okEnv({ id: scr, tags: r.metadata.tags ?? [], created_on: r.created_on, modified_on: r.modified_on, etag: r.etag }));
    }
    return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed`));
  }

  // /namespaces/:ns/scripts/:s/{bindings|content|settings}
  if (scriptSub) {
    const [, ns4, scr, sub] = scriptSub;
    const r = ctx.registry.scripts[ns4!]?.[scr!];
    if (!r) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'script not found'));
    if (method !== 'GET') return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /${sub}`));
    if (sub === 'bindings') {
      // Redact secret_text values; CF returns name+type but no `text`.
      const redacted = (r.metadata.bindings ?? []).map(b => {
        if (b.type === 'secret_text') {
          const { text: _drop, ...rest } = b as { text?: string } & typeof b;
          return rest;
        }
        return b;
      });
      return writeEnv(res, 200, okEnv(redacted));
    }
    if (sub === 'settings') {
      return writeEnv(res, 200, okEnv(r.metadata));
    }
    if (sub === 'content') {
      const scriptDir = path.join(ctx.scriptsDir, ns4!, scr!);
      const files = await listFilesRecursive(scriptDir);
      const boundary = `----wfpsim-${Math.random().toString(36).slice(2)}`;
      const parts: Buffer[] = [];
      const buffers = await Promise.all(files.map(rel => fs.readFile(path.join(scriptDir, rel))));
      for (let i = 0; i < files.length; i++) {
        const rel = files[i]!;
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${rel}"; filename="${rel}"\r\nContent-Type: ${moduleContentType(rel)}\r\n\r\n`));
        parts.push(buffers[i]!);
        parts.push(Buffer.from('\r\n'));
      }
      parts.push(Buffer.from(`--${boundary}--\r\n`));
      res.writeHead(200, { 'content-type': `multipart/form-data; boundary=${boundary}` });
      res.end(Buffer.concat(parts));
      return;
    }
  }

  // /namespaces/:ns/scripts/:s/secrets (collection)
  if (secrets) {
    const [, ns5, scr] = secrets;
    if (!ctx.registry.scripts[ns5!]?.[scr!]) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'script not found'));
    const bag = (ctx.registry.secrets[ns5!] ??= {})[scr!] ??= {};
    if (method === 'GET') {
      // CF returns metadata only (no values).
      return writeEnv(res, 200, okEnv(Object.keys(bag).map(name => ({ name, type: 'secret_text' }))));
    }
    if (method === 'PUT') {
      const body = await readJson(req) as { name?: string; text?: string; type?: string } | null;
      if (!body?.name || typeof body.text !== 'string') return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, 'PUT body must be { name, text, type? }'));
      return await ctx.withLock(async () => {
        bag[body.name!] = body.text!;
        await saveRegistry(ctx.registryFile, ctx.registry);
        // Secrets surface as plain bindings on the user worker; trigger reconfigure
        // so the next request sees them in env.
        await ctx.reconfigure();
        return writeEnv(res, 200, okEnv({ name: body.name, type: body.type ?? 'secret_text' }));
      });
    }
    return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /secrets`));
  }

  // /namespaces/:ns/scripts/:s/secrets/:name
  if (secretByName) {
    const [, ns6, scr, sname] = secretByName;
    if (!ctx.registry.scripts[ns6!]?.[scr!]) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'script not found'));
    const bag = (ctx.registry.secrets[ns6!] ??= {})[scr!] ??= {};
    if (method === 'GET') {
      if (!(sname! in bag)) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'secret not found'));
      return writeEnv(res, 200, okEnv({ name: sname, type: 'secret_text' }));
    }
    if (method === 'DELETE') {
      return await ctx.withLock(async () => {
        delete bag[sname!];
        await saveRegistry(ctx.registryFile, ctx.registry);
        await ctx.reconfigure();
        return writeEnv(res, 200, okEnv({}));
      });
    }
    return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /secrets/:name`));
  }

  return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, `unknown route: ${method} ${url.pathname}`));
}

function matchPath(p: string, re: RegExp): RegExpExecArray | null {
  return re.exec(p);
}

// ───────── Workers Assets API (3-step JWT upload) ─────────

const assetUploadSessions = new Map<string /* sessionJwt */, AssetUploadSession>();

async function handleAssetsUploadSession(
  req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx,
  _ns: string, _script: string,
): Promise<void> {
  const body = await readJson(req) as { manifest?: Record<string, { hash: string; size: number }> } | null;
  const manifestRaw = body?.manifest ?? {};
  const casDir = ctx.paths.assetsCasDir;
  await fs.mkdir(casDir, { recursive: true });

  const manifest: Record<string, string> = {};
  const needed = new Set<string>();
  await Promise.all(Object.entries(manifestRaw).map(async ([p, info]) => {
    const norm = p.startsWith('/') ? p : '/' + p;
    manifest[norm] = info.hash;
    try { await fs.stat(path.join(casDir, info.hash)); } catch { needed.add(info.hash); }
  }));

  const sessionJwt = randomUUID();
  if (needed.size === 0) {
    // No new files — sessionJwt IS the completion token.
    ctx.registry.assets[sessionJwt] = { manifest };
    await saveRegistry(ctx.registryFile, ctx.registry);
    return writeEnv(res, 200, okEnv({ jwt: sessionJwt, buckets: [] }));
  }
  // Sweep abandoned sessions to keep the Map bounded.
  const now = Date.now();
  for (const [jwt, s] of assetUploadSessions) {
    if (now - s.createdAt > ASSET_SESSION_TTL_MS) assetUploadSessions.delete(jwt);
  }
  assetUploadSessions.set(sessionJwt, { jwt: sessionJwt, manifest, needed, createdAt: now });
  // Single bucket (server-defined chunking is allowed; v1 keeps it simple).
  return writeEnv(res, 200, okEnv({ jwt: sessionJwt, buckets: [Array.from(needed)] }));
}

async function handleAssetBucketUpload(
  req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx, url: URL,
): Promise<void> {
  const auth = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  if (!auth) return writeEnv(res, 401, errEnv(CFErrorCode.AUTH_INVALID, 'Bearer token (session JWT) required'));
  const session = assetUploadSessions.get(auth);
  if (!session) return writeEnv(res, 401, errEnv(CFErrorCode.AUTH_INVALID, 'unknown or expired upload session'));

  const isBase64 = url.searchParams.get('base64') === 'true';
  const casDir = ctx.paths.assetsCasDir;

  // Parse multipart; field name = hash, value = file bytes (optionally base64).
  const parts: { hash: string; buffer: Buffer; contentType: string }[] = [];
  await new Promise<void>((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: 100 * 1024 * 1024, files: 5000 } }); }
    catch (e) { reject(e); return; }
    bb.on('field', (name, value) => {
      const buf = isBase64 ? Buffer.from(value, 'base64') : Buffer.from(value, 'binary');
      parts.push({ hash: name, buffer: buf, contentType: 'application/octet-stream' });
    });
    bb.on('file', (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        let buf = Buffer.concat(chunks);
        if (isBase64) buf = Buffer.from(buf.toString('utf8'), 'base64');
        parts.push({ hash: name, buffer: buf, contentType: info.mimeType || 'application/octet-stream' });
      });
      stream.on('error', reject);
    });
    bb.on('finish', resolve);
    bb.on('error', reject);
    req.pipe(bb);
  });

  // Verify each part: hash field-name shape, hash is in the session's manifest,
  // hash matches recomputed content. Field name is attacker-controlled.
  const manifestHashes = new Set(Object.values(session.manifest));
  for (const p of parts) {
    if (!isValidAssetHash(p.hash)) {
      return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, `invalid asset hash field name: ${p.hash}`));
    }
    if (!manifestHashes.has(p.hash)) {
      return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, `unknown asset hash (not in upload session): ${p.hash}`));
    }
    const computed = createHash('sha256').update(p.buffer).digest('hex').slice(0, 32);
    if (computed !== p.hash) {
      return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, `asset hash mismatch: declared ${p.hash}, computed ${computed}`));
    }
  }

  await Promise.all(parts.map(async p => {
    await atomicWrite(path.join(casDir, p.hash), p.buffer);
    session.needed.delete(p.hash);
  }));

  if (session.needed.size === 0) {
    // Mint completion token. Promote session to a persistent completion record.
    const completionJwt = randomUUID();
    ctx.registry.assets[completionJwt] = { manifest: session.manifest };
    await saveRegistry(ctx.registryFile, ctx.registry);
    assetUploadSessions.delete(session.jwt);
    return writeEnv(res, 201, okEnv({ jwt: completionJwt }));
  }
  // Still more buckets to come.
  return writeEnv(res, 202, okEnv({}));
}

// ───────── Tier-2 stubs (just enough so vibesdk-like clients don't error) ─────────

function handleTier2Stubs(
  req: http.IncomingMessage, res: http.ServerResponse, _ctx: HandlerCtx,
  path: string, method: string, _url: URL,
): boolean {
  // KV namespace create (used by codegen agents needing fresh KV).
  if (method === 'POST' && /^\/accounts\/[^/]+\/storage\/kv\/namespaces$/.test(path)) {
    void readJson(req).catch(() => null);
    writeEnv(res, 200, okEnv({ id: randomUUID().replace(/-/g, ''), title: 'sim-kv', supports_url_encoding: true }));
    return true;
  }
  // D1 database create.
  if (method === 'POST' && /^\/accounts\/[^/]+\/d1\/database$/.test(path)) {
    void readJson(req).catch(() => null);
    writeEnv(res, 200, okEnv({ uuid: randomUUID(), name: 'sim-d1', version: 'production' }));
    return true;
  }
  // Images upload — accept and discard.
  if (method === 'POST' && /^\/accounts\/[^/]+\/images\/v1$/.test(path)) {
    writeEnv(res, 200, okEnv({ id: randomUUID(), filename: 'sim.png', uploaded: nowIso(), variants: [] }));
    return true;
  }
  // Browser rendering screenshot.
  if (method === 'POST' && /^\/accounts\/[^/]+\/browser-rendering\/snapshot$/.test(path)) {
    writeEnv(res, 200, okEnv({ status: 'success' }));
    return true;
  }
  // GraphQL analytics — return empty data envelope.
  if (method === 'POST' && /^\/graphql$/.test(path)) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: {}, errors: null }));
    return true;
  }
  return false;
}

// ───────── Custom Hostnames (CF for SaaS) stub ─────────

async function handleCustomHostnames(
  req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx,
  url: URL, method: string, zoneId: string,
): Promise<void> {
  ctx.registry.hostnames[zoneId] ??= {};
  if (method === 'GET') {
    const want = url.searchParams.get('hostname');
    const all = Object.values(ctx.registry.hostnames[zoneId]!);
    const filtered = want ? all.filter(h => h.hostname === want) : all;
    return writeEnv(res, 200, okEnv(filtered.map(renderHostname)));
  }
  if (method === 'POST') {
    const body = await readJson(req) as {
      hostname?: string;
      ssl?: { method?: 'http' | 'txt' | 'email'; type?: 'dv' };
      custom_metadata?: Record<string, string>;
    } | null;
    if (!body?.hostname) return writeEnv(res, 400, errEnv(CFErrorCode.VALIDATION, 'hostname is required', { pointer: '/hostname' }));
    const id = randomUUID().replace(/-/g, '');
    const rec: HostnameRecord = {
      id, zone_id: zoneId, hostname: body.hostname,
      ssl_method: body.ssl?.method ?? 'http',
      ssl_type: body.ssl?.type ?? 'dv',
      ...(body.custom_metadata ? { custom_metadata: body.custom_metadata } : {}),
      created_at: nowIso(),
    };
    ctx.registry.hostnames[zoneId]![id] = rec;
    await saveRegistry(ctx.registryFile, ctx.registry);
    return writeEnv(res, 200, okEnv(renderHostname(rec)));
  }
  return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed on /custom_hostnames`));
}

async function handleCustomHostnameById(
  _req: http.IncomingMessage, res: http.ServerResponse, ctx: HandlerCtx,
  method: string, zoneId: string, id: string,
): Promise<void> {
  const rec = ctx.registry.hostnames[zoneId]?.[id];
  if (method === 'GET') {
    if (!rec) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'custom hostname not found'));
    return writeEnv(res, 200, okEnv(renderHostname(rec)));
  }
  if (method === 'DELETE') {
    if (!rec) return writeEnv(res, 404, errEnv(CFErrorCode.NOT_FOUND, 'custom hostname not found'));
    delete ctx.registry.hostnames[zoneId]![id];
    await saveRegistry(ctx.registryFile, ctx.registry);
    return writeEnv(res, 200, okEnv({ id }));
  }
  return writeEnv(res, 405, errEnv(CFErrorCode.VALIDATION, `method ${method} not allowed`));
}

function renderHostname(r: HostnameRecord): Record<string, unknown> {
  return {
    id: r.id,
    hostname: r.hostname,
    created_at: r.created_at,
    custom_metadata: r.custom_metadata ?? {},
    ssl: {
      id: r.id,
      type: r.ssl_type,
      method: r.ssl_method,
      status: 'active',
      bundle_method: 'ubiquitous',
      certificate_authority: 'lets_encrypt',
      hosts: [r.hostname],
      issuer: "Let's Encrypt",
      serial_number: '0',
      signature: 'SHA256WithRSA',
      uploaded_on: r.created_at,
      expires_on: new Date(Date.parse(r.created_at) + 365 * 24 * 3600 * 1000).toISOString(),
      wildcard: false,
      settings: { http2: 'on', min_tls_version: '1.2', tls_1_3: 'on' },
      validation_errors: [],
      validation_records: [],
    },
    status: 'active',
    verification_errors: [],
    ownership_verification: {
      type: 'txt',
      name: `_cf-custom-hostname.${r.hostname}`,
      value: '00000000-0000-0000-0000-000000000000',
    },
    ownership_verification_http: {
      http_url: `http://${r.hostname}/.well-known/cf-custom-hostname-challenge/sim`,
      http_body: 'sim',
    },
  };
}

/**
 * Parse `?tags=k1:yes,k2:no` filter. AND across predicates. `:yes` = must have, `:no` = must not.
 */
function parseTagFilter(q: string): (tags: string[]) => boolean {
  const preds: { key: string; mustHave: boolean }[] = [];
  for (const part of q.split(',')) {
    const t = part.trim();
    if (!t) continue;
    const i = t.lastIndexOf(':');
    if (i < 0) { preds.push({ key: t, mustHave: true }); continue; }
    const key = t.slice(0, i);
    const verb = t.slice(i + 1).toLowerCase();
    if (verb !== 'yes' && verb !== 'no') throw new Error(`invalid tag predicate "${t}" — must end :yes or :no`);
    preds.push({ key, mustHave: verb === 'yes' });
  }
  return (tags) => preds.every(p => p.mustHave ? tags.includes(p.key) : !tags.includes(p.key));
}

async function listFilesRecursive(root: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(rel: string): Promise<void> {
    let entries;
    try { entries = await fs.readdir(path.join(root, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile()) out.push(r);
    }
  }
  await walk('');
  return out.sort();
}

/** Atomic write: write `path + '.tmp'` then rename to `path`. */
async function atomicWrite(p: string, data: Buffer | string): Promise<void> {
  await fs.writeFile(p + '.tmp', data);
  await fs.rename(p + '.tmp', p);
}

// ───────── Miniflare config ─────────

/** Cache so we only rewrite a per-tenant wrapper when its source actually changes. */
const wrapperCache = new Map<string /* path */, string /* src */>();

/** Binding name synthesized for asset-only tenants that declare no `assets` binding. */
const ASSETS_ONLY_BINDING = '__WFP_ASSETS';

/**
 * Synthesized entry module for asset-only tenants. A Worker deployed with assets
 * and no main module serves assets at the root in production; with no user script
 * to host, we emulate that by delegating every request to the assets binding.
 */
function renderAssetsOnly(bindingName: string): string {
  const b = JSON.stringify(bindingName);
  return `// AUTO-GENERATED by cf-wfp-simulator. Do not edit.
// Asset-only tenant: no user script was deployed, so this module delegates every
// request to the assets binding — matching how Cloudflare serves a Worker that
// was deployed with assets and no main module.
export default {
  async fetch(request, env) {
    const assets = env[${b}];
    if (!assets || typeof assets.fetch !== 'function') {
      return new Response('cf-wfp-simulator: asset-only tenant is missing its assets binding', { status: 500 });
    }
    return assets.fetch(request);
  },
};
`;
}

async function buildMfConfig(
  registry: Registry, scriptsDir: string, persistRoot: string,
  outbounds: PreparedOutbound[] = [],
): Promise<MiniflareOptions> {
  const outboundByNs = new Map(outbounds.map(o => [o.ns, o]));
  const workers: WorkerOptions[] = [];
  workers.push({
    name: '__sim_root',
    modules: true,
    script: 'export default { fetch() { return new Response("cf-wfp-simulator: this Miniflare host is not for direct traffic", { status: 410 }); } };',
    compatibilityDate: '2025-01-01',
  });

  const wrapperWrites: Promise<void>[] = [];

  for (const [ns, scripts] of Object.entries(registry.scripts)) {
    const outbound = outboundByNs.get(ns);
    const outboundService = outbound ? `outbound-bridge__${sanitize(ns)}` : undefined;

    for (const [scriptName, rec] of Object.entries(scripts)) {
      const dir = path.join(scriptsDir, ns, scriptName);
      const entry = rec.metadata.main_module ?? rec.metadata.body_part;
      const translated = translateBindings(rec.metadata.bindings ?? [], getDoStorageModes(rec));
      const scriptSecrets = registry.secrets[ns]?.[scriptName] ?? {};
      const mergedBindings = { ...(translated.bindings ?? {}), ...scriptSecrets };

      const assetsBinding = (rec.metadata.bindings ?? []).find(b => b.type === 'assets');
      const assetsDir = path.join(dir, '__assets');
      // Serve assets whenever the deploy carried a manifest. For asset-only deploys
      // (no entry module) and no user-declared `assets` binding, synthesize one so
      // the generated worker below can delegate to it.
      const assetsBindingName = assetsBinding?.name ?? (!entry && rec.metadata.assets ? ASSETS_ONLY_BINDING : undefined);
      const serveAssets = !!rec.metadata.assets && !!assetsBindingName;

      let compatFlags = rec.metadata.compatibility_flags ?? [];
      let scriptPath: string;

      if (!entry) {
        // Asset-only tenant: no user script. Synthesize a module that serves the
        // assets binding at the root, matching CF's asset-only behavior. deploy()
        // guarantees an asset bundle exists; skip defensively if it somehow doesn't.
        if (!assetsBindingName) continue;
        const assetsOnlyPath = path.join(dir, '__wfp_assets_only.mjs');
        const assetsOnlySrc = renderAssetsOnly(assetsBindingName);
        if (wrapperCache.get(assetsOnlyPath) !== assetsOnlySrc) {
          wrapperCache.set(assetsOnlyPath, assetsOnlySrc);
          wrapperWrites.push(fs.writeFile(assetsOnlyPath, assetsOnlySrc));
        }
        scriptPath = assetsOnlyPath;
      } else {
        scriptPath = path.join(dir, entry);
        // Per-tenant ALS wrapper (only when outbound is configured for this
        // namespace): intercepts the inbound request, captures X-WFP-Outbound, and
        // patches globalThis.fetch to re-attach the header on every subrequest.
        if (outbound) {
          const wrapperPath = path.join(dir, '__wfp_wrapper.mjs');
          const wrapperSrc = renderWrapper(entry);
          if (wrapperCache.get(wrapperPath) !== wrapperSrc) {
            wrapperCache.set(wrapperPath, wrapperSrc);
            wrapperWrites.push(fs.writeFile(wrapperPath, wrapperSrc));
          }
          scriptPath = wrapperPath;
          if (!compatFlags.includes('nodejs_compat') && !compatFlags.includes('nodejs_als')) {
            compatFlags = [...compatFlags, 'nodejs_als'];
          }
        }
      }

      workers.push({
        name: workerName(ns, scriptName),
        modules: true,
        scriptPath,
        modulesRoot: dir,
        compatibilityDate: rec.metadata.compatibility_date ?? '2025-01-01',
        compatibilityFlags: compatFlags,
        ...translated,
        bindings: Object.keys(mergedBindings).length > 0 ? mergedBindings : undefined,
        ...((entry && outboundService) ? { outboundService } : {}),
        ...(serveAssets ? {
          assets: {
            directory: assetsDir,
            binding: assetsBindingName,
            assetConfig: rec.metadata.assets?.config,
          },
        } : {}),
      });
    }
  }

  // Outbound bridge workers — one per namespace that has an outbound configured.
  for (const o of outbounds) {
    const bindings = translateBindings(o.bindings ?? []);
    workers.push({
      name: `outbound-bridge__${sanitize(o.ns)}`,
      modules: true,
      scriptPath: path.join(o.dir, 'bridge.mjs'),
      modulesRoot: o.dir,
      compatibilityDate: '2025-01-01',
      compatibilityFlags: ['nodejs_compat'],
      ...bindings,
      bindings: {
        ...(bindings.bindings ?? {}),
        __WFP_ALLOWED_PARAMS: JSON.stringify(o.parameters),
      },
      // No outboundService — bridge fetches go straight to the network.
    });
  }

  if (wrapperWrites.length > 0) await Promise.all(wrapperWrites);

  return {
    host: '127.0.0.1',
    port: 0, // Miniflare gets an internal port; we never expose it
    defaultPersistRoot: persistRoot,
    workers,
  };
}

interface Translated {
  bindings?: Record<string, unknown>;
  d1Databases?: Record<string, string>;
  kvNamespaces?: Record<string, string>;
  r2Buckets?: Record<string, string>;
  durableObjects?: Record<string, { className: string; scriptName?: string; useSQLite?: boolean }>;
  queueProducers?: Record<string, { queueName: string }>;
  serviceBindings?: Record<string, string>;
}

/**
 * Walk migrations to derive per-class storage mode. Latest declaration wins.
 * CF semantics: classes can't transition mode without a fresh class name.
 */
/**
 * Effective storage mode per DO class actually present in `bindings`. CF requires
 * a class declared as KV or SQLite at first deploy; sim defaults to SQLite when
 * migrations are absent. Used to detect mismatch on redeploy that adds a
 * conflicting `new_classes`/`new_sqlite_classes` migration entry.
 */
function computeEffectiveDoModes(
  bindings: Binding[],
  migrations: DurableObjectMigration[] | undefined,
): Record<string, 'sqlite' | 'kv'> {
  const fromMigrations = computeDoStorageModes(migrations);
  const effective: Record<string, 'sqlite' | 'kv'> = {};
  for (const b of bindings) {
    if (b.type === 'durable_object_namespace') {
      effective[b.class_name] = fromMigrations[b.class_name] ?? 'sqlite';
    }
  }
  return effective;
}

function computeDoStorageModes(
  migrations: DurableObjectMigration[] | undefined,
): Record<string, 'sqlite' | 'kv'> {
  const modes: Record<string, 'sqlite' | 'kv'> = {};
  for (const m of migrations ?? []) {
    for (const c of m.new_classes ?? []) modes[c] = 'kv';
    for (const c of m.new_sqlite_classes ?? []) modes[c] = 'sqlite';
    for (const c of m.deleted_classes ?? []) delete modes[c];
    for (const r of m.renamed_classes ?? []) {
      if (modes[r.from]) { modes[r.to] = modes[r.from]!; delete modes[r.from]; }
    }
  }
  return modes;
}

function translateBindings(
  bindings: Binding[],
  doModes: Record<string, 'sqlite' | 'kv'> = {},
): Translated {
  const acc = {
    bindings: {} as Record<string, unknown>,
    d1Databases: {} as Record<string, string>,
    kvNamespaces: {} as Record<string, string>,
    r2Buckets: {} as Record<string, string>,
    durableObjects: {} as Record<string, { className: string; scriptName?: string; useSQLite?: boolean }>,
    queueProducers: {} as Record<string, { queueName: string }>,
    serviceBindings: {} as Record<string, string>,
  };
  for (const b of bindings) {
    switch (b.type) {
      case 'd1': acc.d1Databases[b.name] = b.id; break;
      case 'kv_namespace': acc.kvNamespaces[b.name] = b.namespace_id; break;
      case 'r2_bucket': acc.r2Buckets[b.name] = b.bucket_name; break;
      case 'durable_object_namespace': {
        // Default to SQLite when no migrations are declared (matches workerd's
        // current default for new DOs and preserves behavior for tests that
        // don't declare migrations).
        const mode = doModes[b.class_name] ?? 'sqlite';
        acc.durableObjects[b.name] = {
          className: b.class_name,
          ...(b.script_name ? { scriptName: b.script_name } : {}),
          useSQLite: mode === 'sqlite',
        };
        break;
      }
      case 'queue': acc.queueProducers[b.name] = { queueName: b.queue_name }; break;
      case 'service': acc.serviceBindings[b.name] = b.service; break;
      case 'plain_text':
      case 'secret_text': acc.bindings[b.name] = b.text; break;
      case 'json': acc.bindings[b.name] = b.json; break;
      case 'assets': /* handled separately via WorkerOptions.assets */ break;
    }
  }
  const out: Translated = {};
  for (const k of Object.keys(acc) as (keyof typeof acc)[]) {
    if (Object.keys(acc[k]).length > 0) (out as Record<string, unknown>)[k] = acc[k];
  }
  return out;
}

export function workerName(ns: string, script: string): string {
  return `user__${sanitize(ns)}__${sanitize(script)}`;
}
function sanitize(s: string): string { return s.replace(/[^A-Za-z0-9_.-]/g, '_'); }

// Path-safety helpers. These guard every filesystem write that takes its name
// from untrusted input (multipart field names, asset manifest paths, namespace
// + script names from REST/programmatic API).

/**
 * Resolve `rel` under `root` and reject if the result escapes `root` or contains
 * obviously unsafe segments. Returns the absolute resolved path, or null on rejection.
 * Rejects: absolute paths, paths containing `..`, paths with empty segments,
 * Windows-style drive letters, leading slashes, paths that resolve outside root.
 */
function safeJoin(root: string, rel: string): string | null {
  if (typeof rel !== 'string' || rel.length === 0) return null;
  if (path.isAbsolute(rel)) return null;
  if (/^[A-Za-z]:[\\/]/.test(rel)) return null; // C:\ etc.
  // Normalize, then check segments. POSIX-style first; path.normalize handles both.
  const segments = rel.split(/[/\\]/);
  for (const seg of segments) {
    if (seg === '' || seg === '.' || seg === '..') return null;
  }
  const resolved = path.resolve(root, rel);
  const rootResolved = path.resolve(root);
  // Ensure resolved path is strictly under root (prefix + sep, or equal).
  if (resolved !== rootResolved && !resolved.startsWith(rootResolved + path.sep)) return null;
  return resolved;
}

/** CF script + namespace names: alphanumeric, underscore, dash, dot. No leading dots, no slashes. */
const SAFE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
function isValidName(s: string): boolean { return typeof s === 'string' && SAFE_NAME_RE.test(s); }

/** Workers Assets uses first-16-bytes-of-SHA-256-as-hex (= 32 hex chars). */
const ASSET_HASH_RE = /^[0-9a-f]{32}$/;
function isValidAssetHash(s: string): boolean { return typeof s === 'string' && ASSET_HASH_RE.test(s); }

const HANDLER_NAMES = ['fetch', 'queue', 'scheduled', 'tail', 'email', 'trace'] as const;
type HandlerName = typeof HANDLER_NAMES[number];

const STRIP_BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STRIP_LINE_COMMENT = /(^|[^:])\/\/[^\n]*/g;
const DEFAULT_EXPORT = /export\s+default\s*\{([\s\S]*?)\}\s*(?:;|$)/m;
const HANDLER_PATTERNS: readonly { name: HandlerName; objectRe: RegExp; namedRe: RegExp }[] =
  HANDLER_NAMES.map(name => ({
    name,
    objectRe: new RegExp(`(^|[\\s,{])(?:async\\s+)?${name}\\s*[(:]`, 'm'),
    namedRe: new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\s*\\(`, 'm'),
  }));

/**
 * Heuristic handler detection from entry-module source. Mirrors what CF reports
 * in the script PUT response. Falls back to ['fetch'] if nothing matches —
 * empty handlers would be more misleading than a default.
 */
function detectHandlers(source: string): string[] {
  const stripped = source.replace(STRIP_BLOCK_COMMENT, '').replace(STRIP_LINE_COMMENT, '$1');
  const defaultBody = DEFAULT_EXPORT.exec(stripped)?.[1] ?? '';

  const found = new Set<HandlerName>();
  for (const { name, objectRe, namedRe } of HANDLER_PATTERNS) {
    if ((defaultBody && objectRe.test(defaultBody)) || namedRe.test(stripped)) found.add(name);
  }

  if (found.size === 0) return ['fetch'];
  // CF's response: fetch first, then alphabetical.
  const sorted = [...found];
  sorted.sort((a, b) => (a === 'fetch' ? -1 : b === 'fetch' ? 1 : a.localeCompare(b)));
  return sorted;
}

// ───────── helpers ─────────

interface UploadModule { name: string; buffer: Buffer; filename?: string }
interface ParsedUpload { metadata: ScriptMetadata; modules: UploadModule[] }

function parseUpload(req: http.IncomingMessage): Promise<ParsedUpload> {
  return new Promise((resolve, reject) => {
    let bb: ReturnType<typeof Busboy>;
    try { bb = Busboy({ headers: req.headers, limits: { fileSize: 50 * 1024 * 1024 } }); }
    catch (e) { reject(e); return; }
    let metadataRaw: string | null = null;
    let metadataBuf: Buffer | null = null;
    const modules: UploadModule[] = [];
    bb.on('field', (name, value) => { if (name === 'metadata') metadataRaw = value; });
    bb.on('file', (name, stream, info) => {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (name === 'metadata') { metadataBuf = buf; return; }
        // Module-name resolution rules (in priority order):
        //   - CF API + Wrangler convention: field name IS the module specifier
        //   - CF SDK + many templates use generic field names ("files", "files[]",
        //     "script") and put the real module name in Content-Disposition filename.
        // We store both; the resolver below picks based on what metadata.main_module
        // references.
        modules.push({ name, buffer: buf, filename: info.filename });
      });
      stream.on('error', reject);
    });
    bb.on('finish', () => {
      const raw = metadataRaw ?? metadataBuf?.toString('utf8') ?? null;
      if (!raw) return reject(new Error('multipart upload missing metadata part'));
      try {
        const metadata = JSON.parse(raw) as ScriptMetadata;
        const entry = metadata.main_module ?? metadata.body_part;
        // Asset-only deploys can omit a script entirely — treat as fine.
        if (!entry && !metadata.assets) return reject(new Error('metadata.main_module or .body_part is required (or .assets for asset-only deploys)'));
        // Resolve modules: field-name match wins; otherwise filename match (Content-Disposition).
        const resolved: UploadModule[] = modules.map(m => {
          if (entry && m.name === entry) return m;
          if (entry && m.filename === entry) return { ...m, name: entry };
          // Generic field names ("files", "files[]", "script", "module"): use filename.
          if (m.filename && /^(files\[?\]?|script|module)$/i.test(m.name)) return { ...m, name: m.filename };
          return m;
        });
        if (entry && !resolved.some(m => m.name === entry)) {
          return reject(new Error(`metadata.main_module references "${entry}" but no matching module part was uploaded`));
        }
        resolve({ metadata, modules: resolved });
      } catch (e) { reject(e); }
    });
    bb.on('error', reject);
    req.pipe(bb);
  });
}

async function loadRegistry(p: string): Promise<Registry> {
  try {
    const raw = await fs.readFile(p, 'utf8');
    const r = JSON.parse(raw) as Partial<Registry>;
    return {
      namespaces: r.namespaces ?? {},
      scripts: r.scripts ?? {},
      secrets: r.secrets ?? {},
      hostnames: r.hostnames ?? {},
      assets: r.assets ?? {},
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { namespaces: {}, scripts: {}, secrets: {}, hostnames: {}, assets: {} };
    throw e;
  }
}
async function saveRegistry(p: string, r: Registry): Promise<void> {
  await atomicWrite(p, JSON.stringify(r, null, 2));
}

function nowIso(): string { return new Date().toISOString(); }
function okEnv<T>(result: T): CFEnvelope<T> { return { result, success: true, errors: [], messages: [] }; }

/**
 * CF API error codes. Real Cloudflare uses numeric codes per error type;
 * client SDKs (wrangler, the official `cloudflare` npm SDK, vibesdk's deployer)
 * branch on `errors[0].code`. Returning a generic envelope without a code
 * silently breaks their retry/handling logic.
 *
 * Source: developers.cloudflare.com/api error tables; verified against
 * cloudflare-typescript SDK error subclasses.
 */
export const CFErrorCode = {
  AUTH_INVALID: 10000,
  VALIDATION: 10006,
  NOT_FOUND: 10007,
  CONFLICT: 10009,
  /** DO class declared with conflicting storage backend (KV vs SQLite). vibesdk auto-retries on this. */
  DO_STORAGE_MISMATCH: 10074,
} as const;

function errEnv(code: number, message: string, opts?: { documentation_url?: string; pointer?: string }): CFEnvelope<null> {
  const err: { code: number; message: string; documentation_url?: string; source?: { pointer: string } } = { code, message };
  if (opts?.documentation_url) err.documentation_url = opts.documentation_url;
  if (opts?.pointer) err.source = { pointer: opts.pointer };
  return { result: null, success: false, errors: [err], messages: [] };
}

function writeEnv(res: http.ServerResponse, status: number, env: CFEnvelope<unknown>): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(env));
}
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return null;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return null; }
}
function headersToObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => { if (k !== 'transfer-encoding') o[k] = v; });
  return o;
}
