import { API, AppError, DISCOVERY, ISSUER, TOKEN, apiError, cancelled, checkAbort, deadline, type Fetcher } from './core';

const FIXED = new Set([DISCOVERY, TOKEN, `${API}/models`, `${API}/responses`]);
export function authMetadataUrl(value: unknown): string {
  if (typeof value !== 'string') throw new AppError('OpenAI authentication metadata is incomplete.');
  const url = new URL(value);
  if (url.origin !== ISSUER || url.username || url.password || url.search || url.hash || url.port || !url.pathname.startsWith('/')) {
    throw new AppError('Rejected a non-official authentication metadata URL.');
  }
  return url.href;
}
export async function readLimited(response: Response, maxBytes = 8 * 1024 * 1024): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new AppError('The service response exceeds the size limit.');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
export class HttpClient {
  private readonly metadataUrls = new Set<string>();
  constructor(private readonly fetcher: Fetcher = fetch, private readonly timeoutMs = 20000) {}
  trustMetadataUrl(value: unknown): string {
    const url = authMetadataUrl(value); this.metadataUrls.add(url); return url;
  }
  async use<T>(url: string, init: RequestInit, signal: AbortSignal, consume: (response: Response) => Promise<T>, timeoutMs = this.timeoutMs): Promise<T> {
    if (!FIXED.has(url) && !this.metadataUrls.has(url)) throw new AppError('Rejected an unauthorized request URL.', 'permission');
    const operation = deadline(timeoutMs, [signal]);
    try {
      checkAbort(operation.signal);
      const response = await this.fetcher(url, { ...init, redirect: 'error', signal: operation.signal });
      if (!response.ok) {
        const raw = await readLimited(response, 65536); let body: unknown;
        try { body = JSON.parse(raw); } catch { body = undefined; }
        throw apiError(response.status, body, response.headers.get('x-request-id') ?? undefined);
      }
      const result = await consume(response); checkAbort(operation.signal); return result;
    } catch (error) {
      if (operation.signal.aborted) throw cancelled();
      if (error instanceof AppError) throw error;
      throw new AppError('The OpenAI network request could not be completed. It was not automatically retried or switched to another billing route.', 'network');
    } finally { operation.dispose(); }
  }
  async json(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<unknown> {
    return this.use(url, init, signal, async response => {
      try { return JSON.parse(await readLimited(response)); }
      catch (error) { if (error instanceof AppError) throw error; throw new AppError('OpenAI returned invalid JSON.'); }
    });
  }
  form(url: string, body: URLSearchParams, signal: AbortSignal): Promise<unknown> {
    return this.json(url, signal, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: body.toString() });
  }
  async revoke(url: string, body: URLSearchParams, signal: AbortSignal): Promise<void> {
    await this.use(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() }, signal,
      async response => { await readLimited(response, 65536); });
  }
}
