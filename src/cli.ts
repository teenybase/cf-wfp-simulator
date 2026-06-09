#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { startSimulator, type OutboundConfig } from './sim.js';

const args = process.argv.slice(2);
const flags = new Map<string, string>();
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (a.startsWith('--')) {
    const k = a.slice(2);
    const v = args[i + 1];
    if (v != null && !v.startsWith('--')) { flags.set(k, v); i++; }
    else flags.set(k, 'true');
  }
}

if (flags.has('help') || flags.has('h')) {
  process.stdout.write(`
cf-wfp-simulator — local WFP simulator on a single URL.

USAGE
  cf-wfp-simulator [options]

OPTIONS
  --port <n>          Listen port (default: 8788).
  --host <addr>       Bind address (default: 127.0.0.1).
  --root <dir>        Persist + scripts dir (default: .wfp-local).
  --outbounds <file>  Path to JSON config wiring outbound workers per namespace
                      (see OUTBOUNDS JSON SHAPE below).
  --auth-token <tok>  Bearer token to require on the CF API. Also reads
                      WFP_SIM_AUTH_TOKEN. Default: any token accepted.
  --insecure          Required to bind a non-loopback host without --auth-token.
                      Without it, non-loopback binds fail closed.
  --quiet             Suppress per-request logging (default: log one line per request to stderr).

WORKFLOW
  1. In your dispatcher source: import { wfpDispatcher } from 'cf-wfp-simulator/wrap';
     replace 'env.dispatcher' with 'wfpDispatcher(env)'.
  2. Add WFP_SIM_URL to your wrangler.jsonc 'vars' (point at this sim).
  3. Run this in tab 1, run 'wrangler dev' in tab 2. Done.

OUTBOUNDS JSON SHAPE
  {
    "production": {
      "scriptPath": "./outbound-worker.mjs",
      "parameters": ["customer_id", "tier"],
      "bindings": [{ "type": "kv_namespace", "name": "CACHE", "namespace_id": "x" }]
    }
  }
  Paths in scriptPath are resolved relative to the JSON file's directory.
`);
  process.exit(0);
}

let outbounds: Record<string, OutboundConfig> | undefined;
const outboundsArg = flags.get('outbounds');
if (outboundsArg) {
  const raw = await readFile(outboundsArg, 'utf8');
  const parsed = JSON.parse(raw) as Record<string, OutboundConfig>;
  const baseDir = path.dirname(path.resolve(outboundsArg));
  outbounds = Object.fromEntries(
    Object.entries(parsed).map(([ns, cfg]) => [
      ns,
      { ...cfg, scriptPath: path.resolve(baseDir, cfg.scriptPath) },
    ]),
  );
}

const host = flags.get('host') ?? '127.0.0.1';
const authToken = flags.get('auth-token') ?? process.env.WFP_SIM_AUTH_TOKEN;
const isLoopback = host === '127.0.0.1' || host === 'localhost' || host === '::1';

if (!isLoopback && !authToken && !flags.has('insecure')) {
  process.stderr.write(
    `\n[cf-wfp-simulator] refusing to bind ${host} without --auth-token.\n` +
    `The CF REST API mock accepts script deploys; binding non-loopback without\n` +
    `auth would expose it to anyone on the interface. Set --auth-token <tok>,\n` +
    `or pass --insecure to override (not recommended).\n\n`
  );
  process.exit(2);
}

// workerd spawn ENOENT can surface either as a sync throw from startSimulator()
// OR as an unhandled rejection from inside Miniflare, depending on the version.
// Hook both paths so the Alpine fix hint always fires.
function maybeAlpineHint(e: unknown): boolean {
  const msg = ((e as NodeJS.ErrnoException)?.message ?? String(e)) || '';
  if (!/workerd/i.test(msg) && !/spawn .* ENOENT/.test(msg)) return false;
  process.stderr.write(
    `\n[cf-wfp-simulator] workerd binary failed to launch.\n` +
    `If you're on Alpine/musl, glibc isn't present — run the bundled fix:\n` +
    `  bash node_modules/cf-wfp-simulator/scripts/fix-alpine-workerd.sh .\n` +
    `Then re-run cf-wfp-simulator. Re-run this fix after every \`npm install\`.\n\n`
  );
  return true;
}
function fatal(e: unknown): never {
  if (!maybeAlpineHint(e)) process.stderr.write(`${(e as Error)?.stack ?? e}\n`);
  process.exit(1);
}
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

let sim;
try {
  sim = await startSimulator({
    port: Number(flags.get('port') ?? 8788),
    host,
    rootDir: flags.get('root') ?? '.wfp-local',
    ...(authToken ? { authToken } : {}),
    ...(outbounds ? { outbounds } : {}),
    ...(flags.has('quiet') ? { log: 'quiet' as const } : {}),
  });
} catch (e) {
  if ((e as NodeJS.ErrnoException)?.code === 'EADDRINUSE') {
    process.stderr.write(
      `\n[cf-wfp-simulator] port ${flags.get('port') ?? 8788} is already in use.\n` +
      `Pass --port <n> to choose a different one.\n\n`
    );
    process.exit(1);
  }
  fatal(e);
}

process.stderr.write(`[cf-wfp-simulator] state: ${path.resolve(flags.get('root') ?? '.wfp-local')}\n`);

process.on('SIGINT', async () => {
  console.log('\n[cf-wfp-simulator] shutting down…');
  await sim.dispose();
  process.exit(0);
});
