import { AppError } from '../core';
export interface SseEvent { event?: string; data: string }
/** Keeps a trailing CR until the next chunk, so split CRLF never creates a false blank line. */
export class SseParser {
  private buffer = ''; private data: string[] = []; private event: string | undefined; private bytes = 0;
  push(chunk: string, final = false): SseEvent[] {
    this.buffer += chunk;
    if (this.buffer.length > 4 * 1024 * 1024) throw new AppError('The SSE buffer exceeds the size limit.');
    const events: SseEvent[] = [];
    for (;;) {
      const index = this.buffer.search(/[\r\n]/);
      if (index < 0) break;
      const cr = this.buffer[index] === '\r';
      if (cr && index === this.buffer.length - 1 && !final) break;
      const line = this.buffer.slice(0, index);
      const skip = cr && this.buffer[index + 1] === '\n' ? 2 : 1;
      this.buffer = this.buffer.slice(index + skip);
      if (!line) {
        if (this.data.length) events.push({ ...(this.event ? { event: this.event } : {}), data: this.data.join('\n') });
        this.data = []; this.event = undefined; this.bytes = 0; continue;
      }
      if (line.startsWith(':')) continue;
      const colon = line.indexOf(':'); const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
      if (field === 'data') { this.bytes += value.length; this.data.push(value); }
      if (field === 'event') this.event = value;
      if (this.bytes > 2 * 1024 * 1024) throw new AppError('The SSE event exceeds the size limit.');
    }
    // An unterminated event is discarded per SSE; the caller still requires response.completed.
    return events;
  }
}
export type NonStreamFormat = 'json' | 'json-invalid' | 'json-too-large' | 'html' | 'empty' | 'blank-too-large';
export async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal,
  rejectNonStream?: (format: NonStreamFormat, payload?: unknown) => never): AsyncGenerator<SseEvent> {
  const reader = body.getReader(); const parser = new SseParser(); const decoder = new TextDecoder('utf-8', { fatal: true });
  let inspect = !!rejectNonStream; let prefix = '';
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      let chunk = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (inspect && rejectNonStream) {
        prefix += chunk;
        const start = prefix.trimStart();
        if (!start) {
          if (prefix.length > 8192) rejectNonStream('blank-too-large');
          if (done) rejectNonStream('empty');
          continue;
        }
        if (start.startsWith('<')) rejectNonStream('html');
        if (start.startsWith('{') || start.startsWith('[')) {
          // Error envelopes can arrive with HTTP 200. Inspect bounded JSON, never expose its values.
          let bytes = Buffer.byteLength(prefix);
          if (bytes > 65536) rejectNonStream('json-too-large');
          if (!done) for (;;) {
            signal.throwIfAborted();
            const next = await reader.read();
            if (next.done) { prefix += decoder.decode(); break; }
            bytes += next.value.byteLength;
            if (bytes > 65536) rejectNonStream('json-too-large');
            prefix += decoder.decode(next.value, { stream: true });
          }
          let payload: unknown;
          try { payload = JSON.parse(prefix); } catch { rejectNonStream('json-invalid'); }
          rejectNonStream('json', payload);
        }
        inspect = false; chunk = prefix; prefix = '';
      }
      for (const event of parser.push(chunk, done)) yield event;
      if (done) return;
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
