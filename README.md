# cf-wfp-simulator

<!-- Badges activate after the first npm publish + GitHub repo go live.
[![npm](https://img.shields.io/npm/v/cf-wfp-simulator.svg)](https://www.npmjs.com/package/cf-wfp-simulator)
[![license](https://img.shields.io/npm/l/cf-wfp-simulator.svg)](./LICENSE)
[![CI](https://github.com/teenybase/cf-wfp-simulator/actions/workflows/test.yml/badge.svg)](https://github.com/teenybase/cf-wfp-simulator/actions/workflows/test.yml)
-->

**Run a Cloudflare Workers for Platforms (WFP) project end-to-end on your laptop.** Deploy tenant Workers, dispatch requests to them, hit the CF REST API — all locally, no Cloudflare account needed until launch.

## What this fixes

[Workers for Platforms](https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/) lets a SaaS host untrusted per-tenant Workers via a `dispatch_namespaces` binding (`env.dispatcher.get(name).fetch(req)`). Cloudflare's official local-dev path runs the *dispatcher* worker locally but routes `env.dispatcher.get(...)` to **real, deployed user Workers in your CF account** — you can't iterate on tenant code without deploying. This package closes that gap: tenants run in local Miniflare, the dispatch + REST + custom-hostname surface is faithfully mocked, and one env var flips between local and real CF.

```
            tab 2                              tab 1
  ┌──────────────────────┐         ┌─────────────────────────┐
  │  wrangler dev :8787  │  HTTP   │  cf-wfp-simulator :8788 │
  │   your dispatcher    │ ──────> │  ├ /__wfp/dispatch/...  │ ──> Miniflare hosts
  │   (wfpDispatcher)    │         │  └ /accounts/.../...    │     your tenant Workers
  └──────────────────────┘         └─────────────────────────┘
```

## Quick start

```sh
npm i -D cf-wfp-simulator
```

For the smallest working setup, see **[`examples/hello-world/`](./examples/hello-world/)** — two tabs and you have a dispatcher routing to a tenant.

In your dispatcher source:
```ts
import { wfpDispatcher } from 'cf-wfp-simulator/wrap';

export default {
  async fetch(req, env) {
    const dispatcher = wfpDispatcher(env);
    return dispatcher.get('customer-a').fetch(req);
  },
};
```

In your `wrangler.jsonc`:
```jsonc
"vars": {
  "WFP_SIM_URL": "http://127.0.0.1:8788"
}
```

```sh
# tab 1
npx cf-wfp-simulator   # listens on 8788

# tab 2
wrangler dev           # listens on 8787
```

Deploy at least one tenant first — the example's [`deploy-tenant`](./examples/hello-world/src/deploy-tenant.mjs) script (via `WFPClient`), or whatever path your platform uses to push tenant scripts — then hit your wrangler dev URL.

## How it works

- `wfpDispatcher(env)` returns an object with the same shape as a CF `dispatch_namespaces` binding (`.get(name).fetch(req)`).
- When `env.WFP_SIM_URL` is set, it makes plain HTTP fetches to the simulator. The simulator hosts your tenant scripts in Miniflare.
- When `env.WFP_SIM_URL` is unset, it returns the real `env.dispatcher` binding. **Same dispatcher source, dev and prod.**

If your platform code *also* calls the Cloudflare REST API to manage tenants (deploy, list, delete), set a second env var `CF_API_BASE=http://127.0.0.1:8788` and replace any hardcoded `https://api.cloudflare.com` with `${env.CF_API_BASE ?? "https://api.cloudflare.com"}`. See [INTEGRATION.md](./INTEGRATION.md).

## Going to production

Drop `WFP_SIM_URL` (and `CF_API_BASE` if used). `wrangler deploy` your dispatcher with a real `dispatch_namespaces` binding. That's the entire production diff.

## Deploying tenants

Three paths, depending on where the deploy code lives:

- **CLI** — `CLOUDFLARE_API_BASE_URL=http://127.0.0.1:8788 wrangler deploy --dispatch-namespace production` (no code change)
- **Inside your dispatcher worker** — patch hardcoded `https://api.cloudflare.com/client/v4` to `${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4`, or pass `baseURL: env.CF_API_BASE` to `new Cloudflare({ apiToken })`
- **From a Node platform backend** —
  ```ts
  import { WFPClient } from 'cf-wfp-simulator/client';
  const client = new WFPClient({ base: process.env.WFP_API_BASE ?? 'http://127.0.0.1:8788' });
  await client.deploy({
    namespace: 'production', scriptName: 'customer-a',
    mainModule: 'worker.mjs', files: { 'worker.mjs': scriptSource },
    bindings: [{ type: 'd1', name: 'DB', id: 'customer-a-db' }],
  });
  ```

The simulator implements the CF REST API: same multipart formats, same response envelopes, same error codes (`10006` validation, `10007` not found, `10009` conflict). All deploy paths work unchanged.

## What it covers

- ✅ Tenant routing via `wfpDispatcher` (the main thing)
- ✅ D1, KV, R2, plain_text, secret_text, queue, service, JSON, assets bindings on tenants
- ✅ Durable Objects (SQLite-backed), state survives restarts + redeploys
- ✅ CF REST API mock: script CRUD, tag filter / bulk delete, namespace CRUD + rename, GET `/bindings` (with secret redaction), GET `/content` (multipart echo), GET `/settings`, secrets API
- ✅ **Workers Assets** 3-step JWT upload flow (assets-upload-session + bucket upload + script PUT with `assets` binding) — `env.ASSETS.fetch(req)` works locally
- ✅ **Custom Hostnames** stub (`/zones/.../custom_hostnames`) — returns active SSL immediately (Let's Encrypt CA, matching CF's default)
- ✅ **Outbound workers** with per-call parameter projection from `dispatcher.get(_, _, { outbound })` (via AsyncLocalStorage in a per-tenant wrapper). Wire from `npx cf-wfp-simulator --outbounds outbounds.json` or programmatically via `SimulatorOptions.outbounds`.
- ✅ **Per-class DO storage mode** — sim honors `metadata.migrations` (`new_classes` ⇒ KV, `new_sqlite_classes` ⇒ SQLite). Re-deploy that flips storage backend rejected with `400 + DO_STORAGE_MISMATCH 10074`, matching prod
- ✅ **Handler detection** (`fetch`/`queue`/`scheduled`/`tail`/`email`/`trace`) from the entry module — script PUT response reflects what's actually exported, not a hardcoded `['fetch']`
- ✅ Tier-2 stubs for vibesdk-style platforms: KV/D1 namespace create (200-stub only — see Limitations), images, browser-rendering, GraphQL analytics
- ✅ `wrangler deploy --dispatch-namespace` works with one `CLOUDFLARE_API_BASE_URL` env var

## Limitations

- DNS / TLS for custom hostnames — the API surface is mocked but the domain doesn't actually route locally (use `/etc/hosts` + the dispatcher's port `:8787` to test)
- Container bindings (vibesdk's `Sandbox` DO) — out of scope
- AI / Vectorize / Hyperdrive bindings on tenants — not implemented
- Real CPU / sub-request limit enforcement (workerd doesn't expose these)
- KV/D1 namespace create endpoints return a stub `id` but don't allocate a Miniflare binding — fine for "did the API call succeed" checks, not for end-to-end tenant data
- KV-backed Durable Objects are honored at the binding level (`useSQLite: false` is set when migrations declare `new_classes`), but workerd's KV-backed DO storage matches prod less faithfully than its SQLite path — quirky semantics around `list({ start, end })` ordering and alarms timing may still differ slightly
- The CF REST API mock accepts any bearer token unless you set `authToken` in `SimulatorOptions`. Default-loopback bind is safe; do not bind `0.0.0.0` without setting `authToken`.

## Tested against

Validated end-to-end against these real Cloudflare WFP projects during development (manual runs — see [TRY_TEMPLATES.md](./TRY_TEMPLATES.md) to reproduce):

- [`cloudflare/templates/workers-for-platforms-template`](https://github.com/cloudflare/templates/tree/main/workers-for-platforms-template) — full UI flow E2E
- [`cloudflare/templates/worker-publisher-template`](https://github.com/cloudflare/templates/tree/main/worker-publisher-template) — admin + deploy + dispatch
- [`cloudflare/workers-for-platforms-example`](https://github.com/cloudflare/workers-for-platforms-example) — admin + KV-mapped tenant routing
- [`cloudflare/vibesdk`](https://github.com/cloudflare/vibesdk) — `WorkerDeployer` pipeline (3-step asset upload + multi-module script PUT)

The automated suite (`npm test`) covers the `wfpDispatcher` wrap, the CF REST mock, Workers Assets (including asset-only deploys), the outbound bridge, DO storage modes, and real `wrangler dev` / `wrangler deploy --dispatch-namespace` subprocesses. The wrangler subprocess tests need network access and Node ≥ 20. [INTEGRATION.md](./INTEGRATION.md) walks through wiring this into your own project.

## Troubleshooting

**Alpine / musl Linux** (including `node:20-alpine` Docker images): `npx cf-wfp-simulator` will exit with `Error: spawn .../workerd ENOENT`. workerd needs glibc; the file exists but the dynamic linker doesn't. Fix:
```sh
sh node_modules/cf-wfp-simulator/scripts/fix-alpine-workerd.sh .
```
The CLI prints this hint when it detects the failure. Re-run after every `npm install` (which overwrites the patched binary).

**Port collision on 8788**: pass `--port`:
```sh
npx cf-wfp-simulator --port 9000
```

**Tenant scripts with the same name in different namespaces**: pass `namespace` to the wrap explicitly:
```ts
const stagingDispatcher = wfpDispatcher(env, { namespace: 'staging' });
const prodDispatcher    = wfpDispatcher(env, { namespace: 'production' });
```
If you pass no `namespace` and `env.WFP_NAMESPACE` is unset, the wrap omits the namespace and the sim searches all namespaces for the first matching script. Set `namespace` (or `env.WFP_NAMESPACE`) to disambiguate when the same script name exists in more than one namespace.

## Credits

Built by the [teenybase](https://github.com/teenybase) team and [Claude](https://claude.com/claude-code).

## License

[Apache-2.0](./LICENSE).
