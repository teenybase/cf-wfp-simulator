import { HEADER_NOT_FOUND, HEADER_ORIGINAL_URL, HEADER_OUTBOUND } from './internal/headers.js';

/**
 * `wfpDispatcher(env, opts?)` — drop-in replacement for `env.dispatcher` from
 * a Cloudflare WFP `dispatch_namespaces` binding.
 *
 * Usage in your dispatcher worker:
 *
 *   import { wfpDispatcher } from 'cf-wfp-simulator/wrap';
 *
 *   export default {
 *     async fetch(request, env, ctx) {
 *       const dispatcher = wfpDispatcher(env);
 *       // -> uses env.WFP_SIM_URL when set (dev: HTTP to local sim)
 *       // -> falls through to env.dispatcher otherwise (prod: real binding)
 *       return dispatcher.get('customer-a').fetch(request);
 *     },
 *   };
 *
 * The shape mirrors CF's runtime exactly: `.get(name, args?, opts?)` returns a
 * stub with `.fetch(request)`. Errors match prod ("Worker not found.").
 *
 * Single env var flip:
 *   - dev:  WFP_SIM_URL=http://localhost:8788   -> talks to cf-wfp-simulator
 *   - prod: WFP_SIM_URL unset                    -> uses env.dispatcher binding
 */

export interface DispatcherEnv {
  /** Real CF binding name. Defaults to "dispatcher" / "DISPATCHER". */
  dispatcher?: DispatchNamespaceLike;
  DISPATCHER?: DispatchNamespaceLike;
  /** When set, the wrap routes through HTTP to this URL instead of the binding. */
  WFP_SIM_URL?: string;
  [k: string]: unknown;
}

export interface DispatchNamespaceLike {
  get(name: string, args?: unknown, opts?: unknown): FetcherLike;
}

export interface FetcherLike {
  fetch(input: Request | string, init?: RequestInit): Promise<Response>;
}

export interface WfpDispatcherOptions {
  /** Override the URL detection. If set, wrap always uses HTTP. */
  base?: string;
  /** Read the binding from a different env key (e.g. "DISPATCHER_PROD"). */
  bindingKey?: string;
  /**
   * Namespace this dispatcher targets. Set this if you deploy the same script
   * name to multiple namespaces (e.g. `staging` + `production`) — otherwise the
   * sim's legacy single-segment lookup picks the first match and silently
   * crosses namespace boundaries. Also reads `env.WFP_NAMESPACE`.
   * Only used in the HTTP path; in prod the binding already encodes the namespace.
   */
  namespace?: string;
}

export function wfpDispatcher(env: DispatcherEnv, opts: WfpDispatcherOptions = {}): DispatchNamespaceLike {
  const base = opts.base ?? env.WFP_SIM_URL;
  if (base) {
    const ns = opts.namespace ?? (typeof env.WFP_NAMESPACE === 'string' ? env.WFP_NAMESPACE : undefined);
    return new HttpDispatcher(base.replace(/\/+$/, ''), ns);
  }
  const key = opts.bindingKey ?? (env.dispatcher ? 'dispatcher' : 'DISPATCHER');
  const real = env[key] as DispatchNamespaceLike | undefined;
  if (!real || typeof real.get !== 'function') {
    throw new Error(
      `wfpDispatcher: no env.${key} binding found and WFP_SIM_URL is not set. ` +
      `Either set WFP_SIM_URL to a cf-wfp-simulator URL, or add a dispatch_namespaces binding named "${key}" in wrangler.jsonc.`
    );
  }
  return real;
}

/**
 * HTTP-backed implementation. Talks to cf-wfp-simulator's data plane.
 *
 * Wire format mirrors what the simulator's HTTP receiver expects:
 *   - URL with namespace:    <base>/__wfp/dispatch/<namespace>/<scriptName>...
 *   - URL without namespace: <base>/__wfp/dispatch/<scriptName>... (sim searches all ns)
 *   - Headers: HEADER_OUTBOUND (JSON of opts.outbound)
 *   - Original method, headers, and body are preserved.
 *   - The simulator's response (status, headers, body) is returned verbatim.
 */
class HttpDispatcher implements DispatchNamespaceLike {
  private readonly encodedNs: string | undefined;
  constructor(private readonly base: string, namespace: string | undefined) {
    this.encodedNs = namespace ? encodeURIComponent(namespace) : undefined;
  }
  get(name: string, args?: unknown, opts?: { outbound?: unknown; limits?: unknown }): FetcherLike {
    return new HttpFetcher(this.base, this.encodedNs, encodeURIComponent(name), args, opts);
  }
}

class HttpFetcher implements FetcherLike {
  constructor(
    private readonly base: string,
    private readonly encodedNs: string | undefined,
    private readonly encodedScript: string,
    private readonly args: unknown,
    private readonly opts: { outbound?: unknown; limits?: unknown } | undefined,
  ) {}

  async fetch(input: Request | string, init?: RequestInit): Promise<Response> {
    const original = new Request(input as RequestInfo, init);
    const url = new URL(original.url);
    const prefix = this.encodedNs
      ? `/__wfp/dispatch/${this.encodedNs}/${this.encodedScript}`
      : `/__wfp/dispatch/${this.encodedScript}`;
    const targetUrl = `${this.base}${prefix}${url.pathname}${url.search}`;

    const headers = new Headers(original.headers);
    headers.set(HEADER_ORIGINAL_URL, original.url);
    // Outbound params are the only opt the sim consumes — they ride to the
    // per-tenant ALS wrapper, which re-attaches them to every subrequest.
    // `args`/`limits` are accepted to match prod's signature but no-op locally.
    if (this.opts?.outbound !== undefined) headers.set(HEADER_OUTBOUND, JSON.stringify(this.opts.outbound));

    // Forward the request body verbatim.
    const body = methodHasBody(original.method) ? original.body : null;

    const r = await fetch(targetUrl, {
      method: original.method,
      headers,
      body,
      // Required by Node's fetch when sending a streaming body.
      // @ts-expect-error — duplex is not in lib.dom yet
      duplex: body ? 'half' : undefined,
      redirect: 'manual',
    });

    // Mirror prod: throw with message "Worker not found." for missing tenants.
    // Subclass so callers can `instanceof WorkerNotFoundError` instead of string-matching.
    if (r.status === 404 && r.headers.get(HEADER_NOT_FOUND) === '1') {
      throw new WorkerNotFoundError(decodeURIComponent(this.encodedScript));
    }
    return r;
  }
}

/**
 * Thrown by the wrap when a tenant script doesn't exist. Subclass of Error so
 * `e.message === 'Worker not found.'` keeps working for code that hasn't migrated.
 */
export class WorkerNotFoundError extends Error {
  constructor(public readonly script: string) {
    super('Worker not found.');
    this.name = 'WorkerNotFoundError';
  }
}

function methodHasBody(method: string): boolean {
  const m = method.toUpperCase();
  return m !== 'GET' && m !== 'HEAD';
}
