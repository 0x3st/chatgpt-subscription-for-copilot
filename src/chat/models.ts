import { API, AppError, record, text } from '../core';
import type { HttpClient } from '../http';
export const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = typeof EFFORTS[number];
export interface ChatModel { id: string; name: string; inputTokens: number; outputTokens: number; images: boolean; tools: boolean; efforts: Effort[]; estimatedLimits: boolean; estimatedInputLimit?: boolean }
export function editorId(id: string): string { return `chatgpt-sub-${Buffer.from(id).toString('base64url')}`; }
function positive(value: unknown): number | undefined { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined; }
export function parseModels(value: unknown): ChatModel[] {
  const payload = record(value);
  if (!Array.isArray(payload?.models)) throw new AppError('Unexpected subscription model catalog format. No API-key models or guessed fallback list were used.');
  const seen = new Set<string>(); const models: ChatModel[] = [];
  for (const item of payload.models) {
    const model = record(item); const id = text(model?.slug);
    if (!model || model.visibility !== 'list' || !id || !/^[a-zA-Z0-9._:-]{1,160}$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const input = positive(model.max_input_tokens ?? model.context_window ?? model.max_context_window);
    const output = positive(model.max_output_tokens);
    const levels = model.supported_reasoning_efforts ?? model.supported_reasoning_levels;
    const efforts = Array.isArray(levels) ? levels.map(level => typeof level === 'string' ? level : record(level)?.effort)
      .filter((level): level is Effort => EFFORTS.includes(level as Effort)) : [];
    const modalities = model.input_modalities ?? model.modalities;
    models.push({ id, name: text(model.display_name) ?? id, inputTokens: input ?? 32768, outputTokens: output ?? 4096,
      images: model.supports_images === true || (Array.isArray(modalities) && modalities.includes('image')),
      tools: model.supports_tools !== false, efforts: [...new Set(efforts)], estimatedLimits: input === undefined || output === undefined,
      estimatedInputLimit: input === undefined });
  }
  if (!models.length) throw new AppError('No visible subscription models are available for this account.', 'permission');
  return models;
}
export async function fetchModels(http: HttpClient, access: string, signal: AbortSignal): Promise<ChatModel[]> {
  return parseModels(await http.json(`${API}/models`, signal, { headers: { Authorization: `Bearer ${access}`, Accept: 'application/json' } }));
}
