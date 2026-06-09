/**
 * Module content-type lookup. Used both:
 *  - by the WFPClient when forming multipart uploads (request side)
 *  - by the sim when echoing modules back via GET /scripts/:n/content (response side)
 *
 * Must agree across both so a script that round-trips through PUT then GET /content
 * returns the same MIME types it was uploaded with.
 *
 * Aligns with (and slightly extends — adds .json/.html/.css/.txt and an
 * octet-stream fallback) what wrangler / the official `cloudflare` SDK send:
 * https://github.com/cloudflare/workers-sdk/blob/main/packages/wrangler/src/deployment-bundle/create-worker-upload-form.ts
 */
export function moduleContentType(rel: string): string {
  if (rel.endsWith('.mjs') || rel.endsWith('.js')) return 'application/javascript+module';
  if (rel.endsWith('.cjs')) return 'application/javascript';
  if (rel.endsWith('.wasm')) return 'application/wasm';
  if (rel.endsWith('.py')) return 'text/x-python';
  if (rel.endsWith('.json')) return 'application/json';
  if (rel.endsWith('.html')) return 'text/html';
  if (rel.endsWith('.css')) return 'text/css';
  if (rel.endsWith('.txt')) return 'text/plain';
  if (rel.endsWith('.map')) return 'application/source-map';
  return 'application/octet-stream';
}
