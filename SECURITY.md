# Security

## Reporting a vulnerability

Email **palash@shaders.app** with `[cf-wfp-simulator security]` in the subject. We will respond within 5 business days.

Do not file public GitHub issues for security reports.

## Scope

This package runs a local HTTP server (default `127.0.0.1:8788`) that hosts tenant Workers via Miniflare. In the default configuration:

- The server binds to loopback only — not exposed externally.
- The CF REST API mock accepts any bearer token unless `authToken` is set in `SimulatorOptions`.
- Tenant scripts run inside the local workerd sandbox.

Things to be cautious about:

- Binding the sim to a non-loopback address (e.g. `0.0.0.0` inside Docker with port-forwarding) without an auth token exposes an unauthenticated script-deploy endpoint to anyone who can reach that interface. The CLI fails closed here: `cf-wfp-simulator --host 0.0.0.0` refuses to start unless you pass `--auth-token <tok>` (or set `WFP_SIM_AUTH_TOKEN`), or explicitly opt out with `--insecure`. This guard is CLI-only — embedded `startSimulator()` callers must set `authToken` in `SimulatorOptions` themselves.
- Tenant scripts have whatever CF Workers can do (network egress, `fetch` to any URL, etc.). Don't run untrusted code without sandboxing the host machine.
