import { wfpDispatcher, WorkerNotFoundError, type DispatcherEnv } from 'cf-wfp-simulator/wrap';

export default {
  async fetch(request: Request, env: DispatcherEnv): Promise<Response> {
    const url = new URL(request.url);
    const [, tenant, ...rest] = url.pathname.split('/');
    if (!tenant) return new Response('usage: /<tenant>/<path>\n', { status: 400 });

    const tenantUrl = new URL('/' + rest.join('/') + url.search, url.origin);
    const tenantReq = new Request(tenantUrl, request);

    const dispatcher = wfpDispatcher(env);
    try {
      return await dispatcher.get(tenant).fetch(tenantReq);
    } catch (e) {
      // In dev (sim) the wrap throws WorkerNotFoundError; in prod the real
      // dispatch binding throws a plain Error with this message.
      if (e instanceof WorkerNotFoundError || (e instanceof Error && e.message === 'Worker not found.')) {
        return new Response('Worker not found.\n', { status: 404 });
      }
      throw e;
    }
  },
};
