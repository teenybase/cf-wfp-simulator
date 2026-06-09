/**
 * WFPClient — HTTP client for the CF REST API surface (script CRUD).
 *
 * Used from your platform backend / CI / scripts, NOT from inside your
 * dispatcher worker. (Inside the dispatcher, use `wfpDispatcher` from
 * 'cf-wfp-simulator/wrap'.)
 *
 * Same code talks to the simulator and to api.cloudflare.com — switch by
 * setting WFP_API_BASE.
 */

import type { Binding, CFEnvelope, ScriptInfo, ScriptMetadata } from './types.js';
import { moduleContentType } from './internal/content-type.js';

export interface WFPClientOptions {
  base?: string;       // default: WFP_API_BASE / CF_API_BASE env, or http://localhost:8788 (sim's default port)
  accountId?: string;  // default: CF_ACCOUNT_ID env or 'local'
  token?: string;      // default: CF_API_TOKEN env or 'dev'
  fetch?: typeof fetch;
}

export interface DeployOptions {
  namespace: string;
  scriptName: string;
  /** Entry module specifier. Omit for asset-only deploys (pass `metadataExtra.assets` instead). */
  mainModule?: string;
  files: Record<string, string | Uint8Array>;
  bindings?: Binding[];
  tags?: string[];
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  metadataExtra?: Partial<ScriptMetadata>;
}

export class WFPClient {
  private readonly base: string;
  private readonly accountId: string;
  private readonly token: string;
  private readonly _fetch: typeof fetch;

  constructor(opts: WFPClientOptions = {}) {
    let base = (opts.base ?? process.env.WFP_API_BASE ?? process.env.CF_API_BASE ?? 'http://localhost:8788').replace(/\/+$/, '');
    // Real CF API requires the /client/v4 prefix. Sim accepts both. Normalize
    // so callers can set base=https://api.cloudflare.com without surprises.
    if (/(^|\/\/)api\.cloudflare\.com$/i.test(base)) base = base + '/client/v4';
    this.base = base;
    this.accountId = opts.accountId ?? process.env.CF_ACCOUNT_ID ?? 'local';
    this.token = opts.token ?? process.env.CF_API_TOKEN ?? 'dev';
    this._fetch = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async deploy(o: DeployOptions): Promise<CFEnvelope<ScriptInfo>> {
    const fd = new FormData();
    const metadata: ScriptMetadata = {
      ...(o.mainModule ? { main_module: o.mainModule } : {}),
      bindings: o.bindings ?? [],
      tags: o.tags ?? [],
      ...(o.compatibilityDate ? { compatibility_date: o.compatibilityDate } : {}),
      ...(o.compatibilityFlags ? { compatibility_flags: o.compatibilityFlags } : {}),
      ...(o.metadataExtra ?? {}),
    };
    fd.append('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }));
    for (const [p, c] of Object.entries(o.files)) {
      fd.append(p, new Blob([c as BlobPart], { type: moduleContentType(p) }), p);
    }
    return this.req<ScriptInfo>('PUT', `/accounts/${enc(this.accountId)}/workers/dispatch/namespaces/${enc(o.namespace)}/scripts/${enc(o.scriptName)}`, { body: fd });
  }

  list(namespace: string): Promise<CFEnvelope<ScriptInfo[]>> {
    return this.req('GET', `/accounts/${enc(this.accountId)}/workers/dispatch/namespaces/${enc(namespace)}/scripts`);
  }

  deleteOne(namespace: string, scriptName: string): Promise<CFEnvelope<null>> {
    return this.req('DELETE', `/accounts/${enc(this.accountId)}/workers/dispatch/namespaces/${enc(namespace)}/scripts/${enc(scriptName)}`);
  }

  private async req<T>(method: string, p: string, init: RequestInit = {}): Promise<CFEnvelope<T>> {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${this.token}`);
    const r = await this._fetch(`${this.base}${p}`, { ...init, method, headers });
    const text = await r.text();
    let body: unknown = null;
    try { body = text ? JSON.parse(text) : null; } catch { /* */ }
    if (!r.ok) {
      throw new WFPError(`${r.status} ${method} ${p}: ${(body as CFEnvelope<T> | null)?.errors?.[0]?.message ?? text}`, r.status, body as CFEnvelope<unknown> | null);
    }
    return body as CFEnvelope<T>;
  }
}

function enc(s: string): string { return encodeURIComponent(s); }

export class WFPError extends Error {
  constructor(msg: string, readonly status: number, readonly envelope: CFEnvelope<unknown> | null) { super(msg); this.name = 'WFPError'; }
}

