# Changelog

## 0.1.1 — 2026-06-09

Post-release fixes from a follow-up code review.

- **Redeploy no longer breaks generated modules.** The atomic deploy dir-swap deleted the generated per-tenant wrapper / asset-only module, and a path cache then skipped rewriting it — so redeploying an outbound or asset-only tenant with unchanged source left a dangling script path (Miniflare load failure). Generated modules are now rewritten whenever the source changes **or** the file is missing.
- **Outbound streaming subrequests fixed.** The per-tenant wrapper's `globalThis.fetch` patch now sets `duplex: 'half'` when a body is present, so `POST`/`PUT`/`PATCH` outbound subrequests with a streaming body no longer throw in workerd.
- **`GET /content` returns only user modules** — the uploaded asset tree (`__assets/`) and sim-generated `__wfp_*` modules are excluded (matching CF). The `__wfp_` module-name prefix is now reserved (rejected on deploy).
- **Multiple `Set-Cookie` headers preserved** on dispatched responses (previously collapsed into one invalid header).
- Namespace-name validation applied at startup (`namespaces` / `outbounds`) too; generated outbound templates interpolate the shared header constant; `WFPClient` supports asset-only deploys; accurate `has_modules`.
- Added a **Related projects** section linking [cf-api-sim](https://github.com/teenybase/cf-api-sim) and [teenybase](https://github.com/teenybase/teenybase).

## 0.1.0 — 2026-06-09

Initial release.

### Hardening from external code review (2026-04-27)

- **Path traversal closed.** Module file names, asset manifest paths, asset hash field names, namespace names, and script names are now validated through `safeJoin()` + `isValidName()`/`isValidAssetHash()` before any filesystem write.
- **Failed redeploys leave the previous tenant intact.** `deploy()` now validates everything (names, paths, asset tokens, DO storage modes) before any filesystem mutation, then writes to a staging directory and atomically swaps. A 400 from the API can never destroy the previously deployed worker.
- **Explicit-namespace dispatch never falls through to legacy lookup.** `wfpDispatcher` always sends `/<ns>/<script>`; if the namespace is known but the script isn't, the sim returns 404 immediately rather than searching across namespaces (which could silently route to a different namespace's script with the same name).
- **Namespace delete cleans up secrets + on-disk files.** Previously a delete + recreate could leak old secrets into the new tenant; namespace rename only ignores `ENOENT`, surfaces other errors.
- **DO storage mode tracked from bindings + migrations** (not just migrations). A first deploy without migrations defaults a DO class to SQLite; a later deploy that adds `new_classes` for the same class is now correctly rejected with `400 + 10074`.
- **Workers Assets verifies hashes.** Each uploaded part's content is SHA-256-hashed and compared against its declared field name; hashes not in the upload session's manifest are rejected.
- **CLI `--auth-token` flag** + `WFP_SIM_AUTH_TOKEN` env var. Binding non-loopback (e.g. `--host 0.0.0.0`) without an auth token now fails closed unless `--insecure` is passed.
- **All registry mutations route through the mutation lock.** Namespace create/rename/delete + secret PUT/DELETE no longer race with each other or with the dispatch reconfigure.
- **`WFPClient` normalizes `https://api.cloudflare.com` → `https://api.cloudflare.com/client/v4`.** All path segments are URI-encoded.
- **Typed errors** — `WorkerNotFoundError` (from `/wrap`), `ValidationError`, `DoStorageMismatchError` are exported so callers can `instanceof` instead of string-matching.
- **`prepare` (not `prepack`) builds `dist/` on `npm install`,** so `file:` and `npm i github:...` installs work without a manual build step.
- **CLI now catches workerd ENOENT (Alpine) on both sync throw and unhandled rejection paths,** prints the fix-script hint, and surfaces a friendly EADDRINUSE message instead of a stack trace.
- **CLI logs `.wfp-local` state directory at startup** so users can see where state is being persisted.

14 new regression tests in `tests/code-review-regressions.test.ts` cover each fix above.

### Additional pre-release fixes

- **Asset-only deploys supported.** A deploy carrying only an asset bundle (no `main_module`) previously crashed config generation; the sim now synthesizes an asset-serving worker so dispatch serves the uploaded assets at the root, matching CF's asset-only behavior.
- **Outbound subrequests with a body fixed.** The generated outbound bridge + per-tenant wrapper now set `duplex: 'half'` when reconstructing requests, so outbound `POST`/`PUT`/`PATCH` no longer throw in workerd.
- **Namespace names validated on the REST API.** `POST` + `PUT` (rename) on `/dispatch/namespaces` now reject unsafe names (path-traversal hardening), matching the validation already applied to script deploys.

### What it does

Local simulator for Cloudflare Workers for Platforms (WFP). Drop the
`wfpDispatcher` wrap into a dispatcher worker, run the sim as a sidecar, and
flip one URL env var to switch between localhost and `api.cloudflare.com`.
`wrangler dev` runs untouched in tab 2.

### Surface

- `cf-wfp-simulator/wrap` — `wfpDispatcher(env)` returns an `env.dispatcher`-shaped
  object. Routes via HTTP when `WFP_SIM_URL` is set; falls through to the real
  binding when unset.
- `cf-wfp-simulator/client` — `WFPClient` for Node-side script CRUD.
- `cf-wfp-simulator` (binary) — boots the sim on port 8788.

### Sim coverage

- Dispatch: `/__wfp/dispatch/<namespace>/<script>/<rest>` (the wrap targets this).
  Old single-segment form `/__wfp/dispatch/<script>/<rest>` still accepted for
  back-compat — searches all namespaces for first match.
- CF REST mock at both `/accounts/...` and `/client/v4/accounts/...`:
  - Script CRUD (PUT/GET/DELETE), tag/binding/asset routes, secret store
  - Workers Assets 3-step JWT upload (assets-upload-session → bucket → script PUT)
  - Tier-2 stubs for vibesdk: KV/D1 namespace create, images, browser-rendering, GraphQL
- Cloudflare for SaaS: `/zones/.../custom_hostnames` — always-active SSL stub (Let's Encrypt CA, matching CF's default)
- Outbound bridge: per-call `dispatcher.get(_, _, { outbound })` params propagated
  via AsyncLocalStorage + a generated per-tenant wrapper module. Configurable
  via the `--outbounds <file>` CLI flag (or `outbounds:` in `SimulatorOptions`).
- Per-class DO storage mode (SQLite vs KV) honored from `metadata.migrations`.
  Re-deploy that flips a class's storage backend rejected with `400` +
  `DO_STORAGE_MISMATCH 10074`.
- Handler list (`fetch`/`queue`/`scheduled`/`tail`/`email`/`trace`) detected
  from the entry module on PUT — not hardcoded.
- Error envelope codes (`CFErrorCode`): `AUTH_INVALID 10000`, `VALIDATION 10006`,
  `NOT_FOUND 10007`, `CONFLICT 10009`, `DO_STORAGE_MISMATCH 10074`.

### Multipart upload formats accepted

CF API/wrangler (`name=<module>`), CF SDK (`name=files`/`files[]` + filename),
and template style (`name=script`/`module` + filename).

### Tested against

- `cloudflare/workers-for-platforms-example`
- `cloudflare/templates/worker-publisher-template`
- `cloudflare/templates/workers-for-platforms-template`
- `cloudflare/vibesdk` (deployer pipeline only)
- Real `wrangler dev` and `wrangler deploy --dispatch-namespace` subprocesses

49 tests across 6 files.

### Known limitations

- DNS / TLS for custom hostnames — API mocked, but visiting the hostname locally
  needs `/etc/hosts` + the dispatcher port (8787 in `wrangler dev`)
- Container bindings (vibesdk's Sandbox DO) — out of scope
- AI / Vectorize / Hyperdrive bindings on tenants — not implemented
- Real CPU / sub-request limit enforcement — workerd doesn't expose
- KV/D1 namespace create endpoints return a stub `id` but don't allocate a
  Miniflare binding — fine for "did the API call succeed" checks, not for
  end-to-end tenant data
- The CF REST API mock accepts any bearer token unless `authToken` is set in
  `SimulatorOptions`. Default-loopback bind is safe; do not bind `0.0.0.0`
  without setting `authToken`.

### Tested platforms

Native build runs on Linux glibc and macOS. On Alpine / musl Linux (including
`node:20-alpine` Docker images), workerd needs glibc — run the bundled
`scripts/fix-alpine-workerd.sh` once after `npm install` (the CLI prints a
hint on failure).
