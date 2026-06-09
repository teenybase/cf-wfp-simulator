# Use cf-wfp-simulator in any WFP project

Two halves of WFP need redirecting to the sim:

- **Routing** (`env.dispatcher.get(name).fetch(req)`) — handled by the wrap import.
- **Management** (uploading/listing/deleting tenant scripts) — handled by redirecting CF REST API calls.

You'll usually need both. Steps:

1. **Install** (dev-only — the wrap is bundled into your worker by wrangler; in prod it falls through to the real binding)
   ```sh
   npm i -D cf-wfp-simulator
   ```

2. **Wire the dispatcher's routing** — in your dispatcher source, replace `env.dispatcher` with the wrap:
   ```ts
   import { wfpDispatcher } from 'cf-wfp-simulator/wrap';
   const dispatcher = wfpDispatcher(env);
   await dispatcher.get('customer-a').fetch(request);
   ```

3. **Wire the management URLs** — pick the path your project actually uses:

   - **3a. CLI deploys** (`wrangler deploy --dispatch-namespace`): no code change. You'll set `CLOUDFLARE_API_BASE_URL` env var in step 6.
   - **3b. Official `cloudflare` SDK in your dispatcher**: pass `baseURL: env.CF_API_BASE` to the constructor.
     ```ts
     new Cloudflare({ apiToken, baseURL: env.CF_API_BASE });
     ```
   - **3c. Raw `fetch()` in your dispatcher**: replace hardcoded `https://api.cloudflare.com` with `env.CF_API_BASE ?? "https://api.cloudflare.com"`.
   - **3d. Node platform backend**: use `WFPClient` from `cf-wfp-simulator` with `base: process.env.WFP_API_BASE`.

4. **Add the env vars** to your `wrangler.jsonc`:
   ```json
   "vars": {
     "WFP_SIM_URL": "http://localhost:8788",
     "CF_API_BASE": "http://localhost:8788"
   }
   ```
   Skip `CF_API_BASE` if you only did 3a or 3d.

   **If your dispatcher checks for CF account/token vars at startup** (templates often do): plain config goes in `wrangler.jsonc`, secrets go in `.dev.vars`.
   ```json
   // wrangler.jsonc — plain config
   "vars": {
     "WFP_SIM_URL": "http://localhost:8788",
     "CF_API_BASE": "http://localhost:8788",
     "ACCOUNT_ID": "local",
     "DISPATCH_NAMESPACE_NAME": "your-namespace-name"
   }
   ```
   ```sh
   # .dev.vars — wrangler dev loads this for secrets (gitignore it)
   DISPATCH_NAMESPACE_API_TOKEN=dev
   CLOUDFLARE_API_TOKEN=dev
   ```
   The sim accepts any value for these. They exist only to satisfy the template's own startup checks.

5. **Tab 1**: `npx cf-wfp-simulator` (listens on 8788)

6. **Tab 2**: `npx wrangler dev` (the real one). For 3a, prefix tenant deploys with the env var:
   ```sh
   CLOUDFLARE_API_BASE_URL=http://localhost:8788 \
   CLOUDFLARE_API_TOKEN=dev CLOUDFLARE_ACCOUNT_ID=local \
     npx wrangler deploy --dispatch-namespace production
   ```

7. **Deploy at least one tenant** (via the path you picked in step 3), then hit your dispatcher's URL — requests route to the local tenant in the sim.

---

**Production switch.** Unset `WFP_SIM_URL` and `CF_API_BASE`. The wrap falls through to `env.dispatcher`; the URL fallbacks resolve to `api.cloudflare.com`. No code change.

**Why two env vars?** `WFP_SIM_URL` is read by the wrap (routing). `CF_API_BASE` is read by your dispatcher's CF API calls (management). They happen to point at the same sim, but they answer different questions: "where do my dispatch calls go?" vs. "where do my script-management API calls go?" In prod, neither is set.

**Gotcha:** sim defaults to port 8788 to leave 8787 free for `wrangler dev`. Change either with `--port`.
