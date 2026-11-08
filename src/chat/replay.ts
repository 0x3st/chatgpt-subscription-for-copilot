import { AppError, record, text } from '../core';
import type { Prepared } from './request';
export interface ReplayGroup { callId: string; name: string; arguments: string; items: Record<string, unknown>[] }
/** Only opaque, server-returned encrypted reasoning is retained; never logged or persisted. */
export function collectReplay(output: readonly unknown[]): ReplayGroup[] {
  const groups: ReplayGroup[] = []; let items: Record<string, unknown>[] = [];
  for (const value of output) {
    const item = record(value);
    if (item?.type === 'reasoning' && text(item.encrypted_content) && text(item.id)) {
      const summary = Array.isArray(item.summary) ? item.summary.filter(value => {
        const part = record(value); return part?.type === 'summary_text' && typeof part.text === 'string';
      }) : [];
      items.push({ type: 'reasoning', id: item.id, encrypted_content: item.encrypted_content, summary });
    }
    if (item?.type === 'function_call' && text(item.call_id) && text(item.name) && typeof item.arguments === 'string' && items.length) {
      groups.push({ callId: item.call_id as string, name: item.name as string, arguments: item.arguments, items }); items = [];
    }
  }
  return groups;
}
function normalizedArguments(value: string): string { return JSON.stringify(JSON.parse(value)); }
export class ReplayCache {
  private readonly entries = new Map<string, { group: ReplayGroup; bytes: number; at: number }>();
  private bytes = 0;
  constructor(private readonly now = () => Date.now()) {}
  private prune(): void {
    for (const [key, entry] of this.entries) if (this.now() - entry.at >= 30 * 60000) {
      this.bytes -= entry.bytes; this.entries.delete(key);
    }
  }
  remember(scope: string, groups: readonly ReplayGroup[]): void {
    this.prune();
    for (const group of groups) {
      const bytes = Buffer.byteLength(JSON.stringify(group));
      if (bytes > 8 * 1024 * 1024) throw new AppError('The reasoning replay context is too large. No tools have been executed for this turn.');
      const key = JSON.stringify([scope, group.callId]); const old = this.entries.get(key);
      if (old) { this.bytes -= old.bytes; this.entries.delete(key); }
      this.entries.set(key, { group: structuredClone(group), bytes, at: this.now() }); this.bytes += bytes;
    }
    while (this.entries.size > 256 || this.bytes > 8 * 1024 * 1024) {
      const key = this.entries.keys().next().value!; this.bytes -= this.entries.get(key)!.bytes; this.entries.delete(key);
    }
  }
  apply(scope: string, prepared: Prepared): Prepared {
    this.prune();
    const input = prepared.body.input as Record<string, unknown>[]; const next: Record<string, unknown>[] = []; const inserted = new Set<string>();
    for (const item of input) {
      const cached = item.type === 'function_call' ? this.entries.get(JSON.stringify([scope, String(item.call_id)])) : undefined;
      if (cached && this.now() - cached.at < 30 * 60000 && cached.group.name === item.name && typeof item.arguments === 'string') {
        let matches = false;
        try { matches = normalizedArguments(cached.group.arguments) === normalizedArguments(item.arguments); } catch { /* Do not replay into edited or malformed history. */ }
        if (matches) for (const reasoning of cached.group.items) {
          const id = String(reasoning.id); if (!inserted.has(id)) { inserted.add(id); next.push(structuredClone(reasoning)); }
        }
      }
      next.push(item);
    }
    const body = { ...prepared.body, input: next };
    if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024 * 1024) throw new AppError('The request including reasoning replay exceeds 32 MiB.');
    return { ...prepared, body };
  }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
