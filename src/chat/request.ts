import { createHash } from 'node:crypto';
import { AppError } from '../core';
import type { ChatModel, Effort } from './models';
import { MATH_INSTRUCTIONS } from './markdown';
export type Content = { type: 'text'; text: string } | { type: 'image'; mime: string; data: Uint8Array };
export type Part = Content | { type: 'call'; id: string; name: string; input: object } | { type: 'result'; id: string; content: Content[] };
export interface Message { role: 'user' | 'assistant'; parts: Part[] }
export interface Tool { name: string; description: string; schema: object }
export interface Prepared { body: Record<string, unknown>; allowed: Map<string, string> }
export const NAMESPACE = 'copilot';
export const NOTEBOOK_INSTRUCTIONS = 'Notebook editing tools currently have known issues in Copilot. For notebook changes, do not use notebook-editing tools or modify .ipynb files through file-editing tools, terminal commands, or scripts. Instead, provide cell-level editing suggestions: identify each target cell from the available context, briefly explain the change, and supply the full replacement cell content in a fenced code block with its language so the user can copy and paste it. If cell contents or identity are unavailable, ask the user to share them; do not invent cells or claim edits, saves, or execution.';
export function wireToolName(name: string): string {
  // Always hash: stable through tool-list changes and cannot collide with a raw name.
  return `t_${createHash('sha256').update(name).digest('hex').slice(0, 40)}`;
}
function image(part: Extract<Content, { type: 'image' }>, model: ChatModel): Record<string, unknown> {
  if (!model.images) throw new AppError('This model has not explicitly declared image support. Images have not been sent.', 'permission');
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mime) || part.data.byteLength > 20 * 1024 * 1024) {
    throw new AppError('The image type is unsupported or its size exceeds 20 MiB.');
  }
  return { type: 'input_image', image_url: `data:${part.mime};base64,${Buffer.from(part.data).toString('base64')}` };
}
export function prepareRequest(model: ChatModel, messages: readonly Message[], tools: readonly Tool[], required: boolean,
  effort: Effort | undefined, summary: boolean, sessionId: string): Prepared {
  if (effort && model.efforts.length && !model.efforts.includes(effort)) throw new AppError('This model has not declared support for the selected reasoning effort. Select default or another supported effort.');
  if (tools.length && !model.tools) throw new AppError('This model does not support tool calling.', 'permission');
  if (required && !tools.length) throw new AppError('Tool calling is required, but no tools are available.');
  const allowed = new Map<string, string>();
  for (const tool of tools) {
    const name = wireToolName(tool.name);
    if (!tool.name || allowed.has(name)) throw new AppError('Tool names must be nonempty and unique; an empty or duplicate name was found.');
    allowed.set(name, tool.name);
  }
  const input: Record<string, unknown>[] = [];
  for (const message of messages) {
    let content: Record<string, unknown>[] = [];
    const flush = () => { if (content.length) input.push({ type: 'message', role: message.role, content }); content = []; };
    for (const part of message.parts) {
      if (part.type === 'text') content.push({ type: message.role === 'assistant' ? 'output_text' : 'input_text', text: part.text });
      else if (part.type === 'image') {
        if (message.role === 'assistant') throw new AppError('Assistant-generated images cannot be replayed as user input.');
        content.push(image(part, model));
      } else if (part.type === 'call') {
        flush(); input.push({ type: 'function_call', call_id: part.id, namespace: NAMESPACE, name: wireToolName(part.name), arguments: JSON.stringify(part.input) });
      } else {
        flush(); const output = part.content.some(value => value.type === 'image')
          ? part.content.map(value => value.type === 'text' ? { type: 'input_text', text: value.text } : image(value, model))
          : part.content.map(value => value.type === 'text' ? value.text : '').join('\n');
        input.push({ type: 'function_call_output', call_id: part.id, output });
      }
    }
    flush();
  }
  if (!input.length) throw new AppError('Cannot send an empty conversation.');
  const body: Record<string, unknown> = {
    model: model.id, instructions: `You are the language model for GitHub Copilot Chat. Follow the supplied conversation and tool instructions. Only call the tools explicitly provided; the editor controls execution and permissions. ${MATH_INSTRUCTIONS} ${NOTEBOOK_INSTRUCTIONS}`,
    input, store: false, stream: true, include: ['reasoning.encrypted_content'], prompt_cache_key: sessionId
  };
  if (tools.length) {
    body.tools = [{ type: 'namespace', name: NAMESPACE, description: 'Tools provided and executed by GitHub Copilot.',
      tools: tools.map(tool => ({ type: 'function', name: wireToolName(tool.name), description: tool.description, parameters: tool.schema, strict: false })) }];
    body.tool_choice = required ? 'required' : 'auto'; body.parallel_tool_calls = false;
  }
  if (effort || summary) body.reasoning = { ...(effort ? { effort } : {}), ...(summary ? { summary: 'auto' } : {}) };
  if (Buffer.byteLength(JSON.stringify(body)) > 32 * 1024 * 1024) throw new AppError('The request exceeds 32 MiB. Reduce images or conversation context.');
  return { body, allowed };
}
export function estimateTokens(messages: readonly Message[] | string): number {
  const estimate = (text: string) => {
    let count = 0; for (const char of text) count += char.codePointAt(0)! <= 127 ? 0.3 : 1;
    return Math.ceil(count);
  };
  if (typeof messages === 'string') return estimate(messages);
  return messages.reduce((total, message) => total + 4 + message.parts.reduce((count, part) => {
    if (part.type === 'image') return count + 2048;
    if (part.type === 'text') return count + estimate(part.text);
    if (part.type === 'call') return count + estimate(part.name + JSON.stringify(part.input));
    return count + part.content.reduce((n, value) => n + (value.type === 'image' ? 2048 : estimate(value.text)), 0);
  }, 0), 0);
}
