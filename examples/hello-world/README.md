# hello-world

Smallest working example: a dispatcher worker that routes `/<tenant>/<path>` to a tenant Worker hosted in the local sim. Two tabs.

```sh
npm install

# Tab 1 — start the simulator (stays running on :8788)
npm run sim

# Tab 2 — deploy a tenant into the running sim, then run the dispatcher
npm run deploy-tenant    # one-time: pushes a tiny tenant into the sim
npm run wrangler         # wrangler dev on :8787 (runs the dispatcher)
```

Then:

```
$ curl http://127.0.0.1:8787/customer-a/hi
hello from customer-a, you asked for /hi

$ curl http://127.0.0.1:8787/no-such-tenant/
Worker not found.
```

## What's in here

- `src/dispatcher.ts` — the dispatcher worker. Imports `wfpDispatcher` from this package, routes the first path segment as the tenant name.
- `src/deploy-tenant.mjs` — Node script: pushes a tiny tenant into the sim via `WFPClient`. Run once after the sim is up.
- `wrangler.jsonc` — the dispatcher's wrangler config. Sets `WFP_SIM_URL` in `vars`. **No `dispatch_namespaces` binding needed in dev** — the wrap reads the env var and routes via HTTP.

## Going to prod

Drop `WFP_SIM_URL` from `vars` and add a real `dispatch_namespaces` binding to `wrangler.jsonc`. The same dispatcher source works in both — that's the whole point.
