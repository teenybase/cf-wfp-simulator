// Pushes a tiny tenant into the running sim. Run once after `cf-wfp-simulator`
// is up. Equivalent to what your platform's backend would do via the CF REST
// API in prod (just pointed at localhost via WFPClient's `base`).

import { WFPClient } from 'cf-wfp-simulator/client';

const client = new WFPClient({
  base: process.env.WFP_API_BASE ?? 'http://127.0.0.1:8788',
});

const tenantSrc = `
export default {
  fetch(request) {
    const url = new URL(request.url);
    return new Response('hello from customer-a, you asked for ' + url.pathname + '\\n');
  },
};
`;

await client.deploy({
  namespace: 'production',
  scriptName: 'customer-a',
  mainModule: 'worker.mjs',
  files: { 'worker.mjs': tenantSrc },
});

console.log('deployed customer-a into namespace production');
console.log('try: curl http://127.0.0.1:8787/customer-a/hi');
