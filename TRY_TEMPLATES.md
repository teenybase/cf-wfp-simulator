# Try the templates yourself

> Walks through running each Cloudflare WFP template against the sim. For your own WFP project, see [INTEGRATION.md](./INTEGRATION.md).

## Setting up the fixtures

The two walkthroughs below cover `workers-for-platforms-template` and `vibesdk`. Clone whichever you want to try into a sibling `wfp-samples/` directory next to your `cf-wfp-simulator` checkout:

```sh
mkdir -p ../wfp-samples && cd ../wfp-samples
git clone https://github.com/cloudflare/templates.git
mv templates/workers-for-platforms-template . && rm -rf templates
git clone https://github.com/cloudflare/vibesdk.git
```

These are manual end-to-end checks — there's no automated template suite in the repo. Clone whichever templates you want to try, then follow the matching walkthrough below to point each one at a running sim.

Apply the line-by-line patches at the bottom of this file before running anything.

---

## A. workers-for-platforms-template

The Hono+D1 platform with admin UI.

1. **Install template deps**
   ```sh
   cd ../wfp-samples/workers-for-platforms-template
   npm install
   ```

2. **Add to the template's `wrangler.jsonc` `vars`** — only these two:
   ```jsonc
   "WFP_SIM_URL": "http://localhost:8788",
   "CF_API_BASE": "http://localhost:8788"
   ```

3. **Create `.dev.vars` at the project root** (gitignore it). This is where wrangler loads dev-only env that doesn't belong in committed config — fields the template's own `wrangler.jsonc` comments mark as "auto-configured by the setup script", plus secrets:
   ```sh
   ACCOUNT_ID=local
   CLOUDFLARE_ZONE_ID=zone-local
   FALLBACK_ORIGIN=http://localhost:8787
   CLOUDFLARE_API_TOKEN=dev
   DISPATCH_NAMESPACE_API_TOKEN=dev
   ```
   The sim accepts any value for any of these.

4. **Tab 1**: `npx cf-wfp-simulator` (anywhere with the package installed)

5. **Tab 2**: `npx wrangler dev` (in the template dir)

6. **Browser**: open `http://localhost:8787/admin` → create a project → deploy a tiny worker or static assets → visit `http://localhost:8787/<your-subdomain>/`.

### Testing custom hostnames (optional)

The sim's custom-hostnames stub returns `status: active` instantly, but the template won't *route* by hostname unless you tell it where the platform itself lives. To exercise the full SaaS-style flow:

1. Add to `wrangler.jsonc` `vars`:
   ```jsonc
   "CUSTOM_DOMAIN": "myplatform.local"
   ```
   (Anything that's not your tenant's custom hostname.)

2. Add `/etc/hosts` entries (need sudo):
   ```
   127.0.0.1 myplatform.local
   127.0.0.1 <your-tenant-subdomain>.myplatform.local
   127.0.0.1 <tenant-custom-hostname>.example
   ```

3. Restart `wrangler dev`. Hit each (always include `:8787`):
   - `http://myplatform.local:8787/admin` → admin UI
   - `http://<sub>.myplatform.local:8787/` → subdomain-routed tenant
   - `http://<tenant-custom-hostname>.example:8787/` → custom-hostname-routed tenant

To use plain port-80 URLs, run `sudo -E npx wrangler dev --port 80`.

---

## B. vibesdk

vibesdk's full host worker needs AI keys + containers — out of scope. The deploy pipeline alone is what talks to the sim, and you can drive it from a small script.

1. **Tab 1**: `npx cf-wfp-simulator` (anywhere with the package installed)

2. **Tab 2**: write `try-vibesdk.mts` **inside `wfp-samples/`** (so the relative import resolves), run with `npx tsx try-vibesdk.mts`:
   ```ts
   import { WorkerDeployer } from './vibesdk/worker/services/deployer/deployer';

   const deployer = new WorkerDeployer('local', 'dev', 'http://localhost:8788');
   const html = '<!doctype html><h1>vibesdk demo</h1>';
   const buf = new TextEncoder().encode(html);
   const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buf))]
     .slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');

   await deployer.deployWithAssets(
     'demo',
     'export default { fetch(r,e){return e.ASSETS.fetch(r)} }',
     '2025-01-01',
     { '/index.html': { hash, size: html.length } },
     new Map([['/index.html', Buffer.from(html)]]),
     [{ type: 'assets', name: 'ASSETS' }],
     undefined, 'production', undefined, undefined, ['nodejs_compat'],
   );
   ```

3. **Verify**: `curl http://localhost:8788/__wfp/dispatch/demo/` → `<!doctype html><h1>vibesdk demo</h1>`

That's the full vibesdk deploy pipeline (3-step JWT asset upload + multi-module script PUT + dispatch via `env.ASSETS`) running locally.

---

## Patches applied to each template — line by line

Line numbers below are approximate — they were verified against the upstream Cloudflare templates in early 2026 and drift as the templates change, so match on the surrounding code rather than the exact line. Production behavior is unchanged when `CF_API_BASE` / `WFP_SIM_URL` are unset (the `??` fallbacks resolve to `https://api.cloudflare.com`).

### `cloudflare/templates/workers-for-platforms-template`

**`src/env.ts`** — add 2 fields to `Env`:
```diff
 export type Env = {
   dispatcher: Dispatcher;
   WORKER_MAPPINGS: KVNamespace;
   DISPATCH_NAMESPACE_NAME: string;
   CLOUDFLARE_ACCOUNT_ID: string;
   CLOUDFLARE_API_TOKEN: string;
+  /** Optional: redirect CF API + dispatcher to a local cf-wfp-simulator. */
+  CF_API_BASE?: string;
+  WFP_SIM_URL?: string;
 }
```

**`src/resource.ts`** — 2 URL substitutions:
```diff
 // line 6-7 (BaseURI helper)
 const BaseURI = (env: Env) =>
-  `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/workers`;
+  `${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4/accounts/${env.ACCOUNT_ID}/workers`;

 // line 153 (inside PutScriptWithAssetsInDispatchNamespace)
-const uploadUrl = `https://api.cloudflare.com/client/v4/accounts/${env.ACCOUNT_ID}/workers/assets/upload?base64=true`;
+const uploadUrl = `${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4/accounts/${env.ACCOUNT_ID}/workers/assets/upload?base64=true`;
```

**`src/cloudflare-api.ts`** — 4 URL substitutions (custom hostnames):
```diff
 // line 42 (createCustomHostname)
-`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames`,
+`${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames`,

 // line 93 (getCustomHostnameStatus)
-`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames?hostname=${hostname}`,
+`${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames?hostname=${hostname}`,

 // line 159 (deleteCustomHostnameByName helper, list-by-hostname call)
-`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames?hostname=${hostname}`,
+`${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames?hostname=${hostname}`,

 // line 179 (deleteCustomHostname by id)
-`https://api.cloudflare.com/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${hostnameId}`,
+`${env.CF_API_BASE ?? "https://api.cloudflare.com"}/client/v4/zones/${env.CLOUDFLARE_ZONE_ID}/custom_hostnames/${hostnameId}`,
```

**`src/index.ts`** — 1 import + 2 dispatcher swaps:
```diff
 // line 24 (top of imports)
+import { wfpDispatcher } from "cf-wfp-simulator/wrap";
 import { Hono } from "hono";

 // line 190 (inside the dispatch middleware, first occurrence)
-const worker = c.env.dispatcher.get(project.subdomain);
+const worker = wfpDispatcher(c.env, { bindingKey: "dispatcher" }).get(project.subdomain);

 // line 199 (inside the catch block — auto-redeploy path)
-const worker = c.env.dispatcher.get(project.subdomain);
+const worker = wfpDispatcher(c.env, { bindingKey: "dispatcher" }).get(project.subdomain);
```

**`src/render.ts`** *(optional — fixes a CF template UI bug, not a sim issue)*:
```diff
 // inside the success branch of the create-website form handler,
 // right after `responseDiv.innerHTML = successHTML;` and the customHostname check
+submitButton.textContent = 'Create & Deploy Website';
+submitButton.disabled = false;
```

**Total in template 1:** 9 lines added, 7 lines changed across 5 files (4 if you skip the optional UI fix).

---

### `cloudflare/vibesdk`

**`worker/services/deployer/api/cloudflare-api.ts`** — constructor accepts a `baseUrl`:
```diff
 export class CloudflareAPI {
   private readonly accountId: string;
   private readonly apiToken: string;
-  private readonly baseUrl = 'https://api.cloudflare.com/client/v4';
+  private readonly baseUrl: string;

-  constructor(accountId: string, apiToken: string) {
+  constructor(accountId: string, apiToken: string, baseUrl?: string) {
     this.accountId = accountId;
     this.apiToken = apiToken;
+    this.baseUrl = (baseUrl ?? 'https://api.cloudflare.com').replace(/\/$/, '') + '/client/v4';
   }
```
(All later `${this.baseUrl}/...` references in the same file work unchanged.)

**`worker/services/deployer/deployer.ts`** — pass through:
```diff
 export class WorkerDeployer {
   private readonly api: CloudflareAPI;

-  constructor(accountId: string, apiToken: string) {
-    this.api = new CloudflareAPI(accountId, apiToken);
+  constructor(accountId: string, apiToken: string, baseUrl?: string) {
+    this.api = new CloudflareAPI(accountId, apiToken, baseUrl);
   }
```

**`worker/index.ts`** *(only if you run vibesdk's full host worker through `wrangler dev`; not needed for the deployer-only flow shown above)*:
```diff
+import { wfpDispatcher } from 'cf-wfp-simulator/wrap';
 …
 // line 111
-const dispatcher = env['DISPATCHER'];
+const dispatcher = wfpDispatcher(env, { bindingKey: 'DISPATCHER' });
```

**Total in template 2:** 4 lines changed, 2 lines added across 2 files (3 if you also patch the host dispatcher).
