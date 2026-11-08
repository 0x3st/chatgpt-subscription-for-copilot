import { API, AppError, apiError, checkAbort, record, text } from '../core';
import type { HttpClient } from '../http';
import { NAMESPACE, type Prepared } from './request';
import { events, type NonStreamFormat } from './sse';
import { collectReplay, type ReplayGroup } from './replay';
export interface ToolCall { id: string; name: string; input: object }
export interface Completion { tools: ToolCall[]; replay: ReplayGroup[]; inputTokens?: number; outputTokens?: number }
export interface TransportInfo { status: number; contentType: string; requestId?: string }
function transportInfo(response: Response): TransportInfo {
  const mediaType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  // Log only an allowlisted media type, never arbitrary header values or parameters.
  const allowed = ['text/event-stream', 'application/json', 'application/problem+json', 'text/html', 'text/plain', 'application/octet-stream'];
  const requestId = apiError(response.status, undefined, response.headers.get('x-request-id') ?? undefined).requestId;
  return { status: response.status, contentType: !mediaType ? 'missing' : allowed.includes(mediaType) ? mediaType : 'other', ...(requestId ? { requestId } : {}) };
}
function transportDetails(info: TransportInfo): string {
  return `HTTP ${info.status}; Content-Type: ${info.contentType}${info.requestId ? `; request ID: ${info.requestId}` : ''}`;
}
function rejectNonStream(info: TransportInfo, format: NonStreamFormat, payload?: unknown): never {
  const object = record(payload);
  if (format === 'json' && object?.error !== undefined) {
    const error = apiError(info.status, payload, info.requestId);
    throw new AppError(`The subscription endpoint returned a JSON error instead of SSE (${transportDetails(info)}). ${error.message}`,
      error.kind, info.status, error.code, info.requestId, 'json-error');
  }
  const shape = format === 'json' && object?.object === 'response' ? 'json-response' : format;
  throw new AppError(`The subscription endpoint did not return SSE (${transportDetails(info)}; body: ${shape}). No tools were executed and no authentication or billing route was changed.`,
    'protocol', info.status, undefined, info.requestId, shape);
}
function toolCall(item: Record<string, unknown>, allowed: Map<string, string>): ToolCall {
  const wire = text(item.name); const id = text(item.call_id);
  const name = wire ? allowed.get(wire) : undefined;
  if (!name || !id || id.length > 256 || item.namespace !== NAMESPACE ||
    (item.status !== undefined && item.status !== 'completed')) throw new AppError('Blocked an undeclared, incorrectly namespaced, or incomplete tool call.', 'permission');
  if (typeof item.arguments !== 'string' || item.arguments.length > 1024 * 1024) throw new AppError('Tool arguments are missing or too large.');
  let input: unknown;
  try { input = JSON.parse(item.arguments); } catch { throw new AppError('Tool arguments are not complete JSON. No tools were executed.'); }
  if (!record(input)) throw new AppError('Tool arguments must be a JSON object. No tools were executed.');
  return { id, name, input: input as object };
}
/** Text streams immediately; tool calls are released only after the successful terminal event. */
export async function complete(http: HttpClient, access: string, prepared: Prepared, signal: AbortSignal,
  onDelta: (type: 'text' | 'summary', value: string) => void, timeoutMs: number,
  onResponse?: (info: TransportInfo) => void): Promise<Completion> {
  return http.use(`${API}/responses`, { method: 'POST',
    headers: { Authorization: `Bearer ${access}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(prepared.body) }, signal, async response => {
    const info = transportInfo(response); onResponse?.(info);
    if (!response.body) rejectNonStream(info, 'empty');
    // Match Pi's OpenAI SDK: stream:true selects SSE parsing, not a MIME-header gate.
    // Valid event framing and a successful terminal event remain mandatory.
    const pending = new Map<string, Record<string, unknown>>(); let pendingBytes = 0;
    for await (const event of events(response.body, signal, (format, payload) => rejectNonStream(info, format, payload))) {
      checkAbort(signal);
      if (event.data === '[DONE]') continue; // Not sufficient proof of a successful response.
      let payload;
      try { payload = record(JSON.parse(event.data)); } catch { throw new AppError('An SSE event contains invalid JSON.'); }
      if (!payload) throw new AppError('Invalid SSE event format.');
      const type = text(payload.type) ?? event.event;
      if (event.event && payload.type && event.event !== payload.type) throw new AppError('SSE event types do not match.');
      if (type === 'response.output_text.delta' || type === 'response.refusal.delta' || type === 'response.reasoning_summary_text.delta') {
        if (typeof payload.delta !== 'string') throw new AppError('Invalid streaming text field.');
        onDelta(type === 'response.reasoning_summary_text.delta' ? 'summary' : 'text', payload.delta);
      } else if (type === 'response.output_item.done') {
        const item = record(payload.item);
        if (item?.type === 'function_call') {
          const id = text(item.call_id); if (!id || pending.has(id)) throw new AppError('A tool call ID is missing or duplicated.');
          pendingBytes += Buffer.byteLength(JSON.stringify(item));
          if (pendingBytes > 8 * 1024 * 1024) throw new AppError('Pending tool calls exceed 8 MiB. No tools have been executed for this turn.');
          if (pending.size >= 128) throw new AppError('The tool call count exceeds the limit.'); pending.set(id, item);
        }
      } else if (type === 'error' || type === 'response.failed') {
        const failure = record(payload.response);
        throw apiError(response.status, { error: failure?.error ?? payload.error ?? payload }, response.headers.get('x-request-id') ?? undefined);
      } else if (type === 'response.incomplete') {
        throw new AppError('The model response is incomplete. No tools were executed. Reduce the context before retrying.');
      } else if (type === 'response.completed') {
        const completed = record(payload.response);
        if (!completed || completed.status !== 'completed' || completed.error) throw new AppError('The terminal event did not confirm success.');
        if ((completed.output !== undefined && !Array.isArray(completed.output)) ||
          (Array.isArray(completed.output) && completed.output.some(value => !text(record(value)?.type)))) throw new AppError('Invalid output list in the completed response.');
        if (Array.isArray(completed.output) && completed.output.some(value => {
          const item = record(value); return typeof item?.type === 'string' && item.type.endsWith('_call') && item.type !== 'function_call';
        })) throw new AppError('The model returned an undeclared tool type. No tools were executed for this turn.', 'permission');
        const finalCalls = Array.isArray(completed.output)
          ? completed.output.map(record).filter((item): item is Record<string, unknown> => item?.type === 'function_call') : [...pending.values()];
        if (finalCalls.length > 128) throw new AppError('The tool call count exceeds the limit.');
        const calls = finalCalls.map(item => toolCall(item, prepared.allowed));
        if (new Set(calls.map(call => call.id)).size !== calls.length) throw new AppError('The completed response contains duplicate tool IDs.');
        // If terminal output is present, it is authoritative; contradictory streamed calls fail closed.
        for (const [id, item] of pending) {
          const match = finalCalls.find(call => call.call_id === id);
          if (!match || match.name !== item.name || match.arguments !== item.arguments || match.namespace !== item.namespace) throw new AppError('Completed tool calls do not match the streamed records.');
        }
        if (prepared.body.tool_choice === 'required' && !calls.length) throw new AppError('The model did not produce the required tool call.');
        const usage = record(completed.usage);
        const input = usage?.input_tokens; const output = usage?.output_tokens;
        return { tools: calls, replay: Array.isArray(completed.output) ? collectReplay(completed.output) : [],
          ...(typeof input === 'number' && Number.isSafeInteger(input) && input >= 0 ? { inputTokens: input } : {}),
          ...(typeof output === 'number' && Number.isSafeInteger(output) && output >= 0 ? { outputTokens: output } : {}) };
      }
    }
    throw new AppError(`The connection ended before response.completed (${transportDetails(info)}). No tools were executed for this turn.`,
      'protocol', info.status, undefined, info.requestId, 'incomplete-stream');
  }, timeoutMs);
}
