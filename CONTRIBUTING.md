# Contributing

## Local setup

```sh
git clone https://github.com/teenybase/cf-wfp-simulator.git
cd cf-wfp-simulator
npm install
npm run check    # type-check
npm run build    # tsc -> dist/
npm test         # vitest
```

On Alpine/musl, after `npm install`:

```sh
sh scripts/fix-alpine-workerd.sh .
```

## Trying it against real templates

There's no automated template suite in the repo. [`TRY_TEMPLATES.md`](./TRY_TEMPLATES.md) walks through pointing real Cloudflare WFP templates at a running sim for manual end-to-end verification.

## Pull requests

- One concern per PR.
- New behavior needs a test. Bug fixes need a regression test.
- `npm run check && npm run build && npm test` must pass.
- No new linter — keep the diff focused on the change.

## Architecture pointers

- `src/wrap.ts` — the public `wfpDispatcher(env)` entry. Falls through to `env.dispatcher` when `WFP_SIM_URL` is unset.
- `src/sim.ts` — single Node HTTP server. Routes: `/__wfp/dispatch/...` (data plane), `/accounts/.../workers/...` (CF REST mock), `/zones/.../custom_hostnames/...` (Cloudflare for SaaS stub), Workers Assets 3-step JWT upload, tier-2 stubs.
- `src/outbound.ts` — generates per-tenant ALS wrapper module so per-call outbound params propagate from `dispatcher.get(_, _, { outbound })` through the user worker's subrequests.
- `src/client.ts` — `WFPClient` for Node-side script CRUD against the sim's REST mock.

## Releasing

Maintainer-only. Push a `vX.Y.Z` tag — `.github/workflows/publish.yml` builds, tests, and publishes via npm Trusted Publishing (OIDC + provenance). No `NPM_TOKEN`.
