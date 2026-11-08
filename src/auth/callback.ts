import { createServer, type ServerResponse } from 'node:http';
import { AppError, cancelled, checkAbort } from '../core';

export interface CallbackResult { code: string; clientId: string }
export interface CallbackListener { redirectUri: string; result: Promise<CallbackResult>; close(): Promise<void> }
function page(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><title>ChatGPT Subscription</title><body><p>${message}</p></body></html>`);
}
export async function listenForOAuth(state: string, signal: AbortSignal, previousClientId?: string): Promise<CallbackListener> {
  checkAbort(signal);
  let resolve!: (result: CallbackResult) => void; let reject!: (error: AppError) => void;
  const result = new Promise<CallbackResult>((yes, no) => { resolve = yes; reject = no; });
  void result.catch(() => undefined);
  let port = 0; let settled = false;
  const server = createServer((request, response) => {
    try {
      if (request.method !== 'GET' || request.headers.host !== `127.0.0.1:${port}` || !request.url?.startsWith('/') || request.url.startsWith('//') || request.url.length > 8192) {
        page(response, 400, 'Invalid request.'); return;
      }
      const url = new URL(request.url, `http://127.0.0.1:${port}`);
      if (url.pathname !== '/auth/callback') { page(response, 404, 'Page not found.'); return; }
      if (settled || url.searchParams.getAll('state').length !== 1 || url.searchParams.get('state') !== state) {
        page(response, 400, 'The callback does not match. Return to VS Code to continue signing in.'); return;
      }
      if (url.searchParams.has('error')) {
        settled = true; page(response, 400, 'Authorization was not completed. Return to VS Code.');
        reject(new AppError('ChatGPT authorization was cancelled or denied.', 'permission')); return;
      }
      const code = url.searchParams.get('code');
      const issued = url.searchParams.get('client_id') ?? previousClientId;
      if (!code || url.searchParams.getAll('code').length !== 1 || !issued || issued === 'dynamic_agent_client' ||
        !/^[a-zA-Z0-9_-]{1,256}$/.test(issued) || url.searchParams.getAll('client_id').length > 1 ||
        (previousClientId && issued !== previousClientId)) {
        page(response, 400, 'Invalid callback fields. Complete authorization again.'); return;
      }
      settled = true; page(response, 200, 'Authorization callback received. Return to VS Code to check the sign-in result, then close this page.');
      resolve({ code, clientId: issued });
    } catch { page(response, 400, 'Invalid request.'); }
  });
  server.requestTimeout = 5000; server.headersTimeout = 5000; server.setTimeout(5000);
  const onAbort = () => { if (!settled) { settled = true; reject(cancelled()); } server.close(); server.closeAllConnections(); };
  server.on('error', () => { if (!settled) { settled = true; reject(new AppError('The local OAuth callback listener failed.', 'network')); } });
  await new Promise<void>((resolveListen, rejectListen) => {
    const error = () => rejectListen(new AppError('Could not start the local OAuth callback listener.', 'network'));
    server.once('error', error);
    server.listen(0, '127.0.0.1', () => { server.removeListener('error', error); resolveListen(); });
  });
  const address = server.address();
  if (!address || typeof address === 'string') { server.close(); throw new AppError('Could not determine the OAuth callback URL.'); }
  port = address.port;
  signal.addEventListener('abort', onAbort, { once: true }); if (signal.aborted) onAbort();
  return { redirectUri: `http://127.0.0.1:${port}/auth/callback`, result,
    async close() {
      signal.removeEventListener('abort', onAbort);
      if (!settled) { settled = true; reject(cancelled()); }
      await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
    } };
}
