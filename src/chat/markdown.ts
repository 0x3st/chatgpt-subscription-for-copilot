/** Copilot owns rendering. Only adapt TeX delimiters to its native Markdown math syntax. */
export const MATH_INSTRUCTIONS = 'For mathematical notation in prose, use Markdown LaTeX: $...$ for inline math and $$ on separate lines for display math. Do not wrap formulas in code spans or code fences unless the user asks for literal source. Preserve code, tool arguments, and the conversation language.';

const MAX_PENDING = 64 * 1024;
type Fence = { marker: string; length: number; closing: boolean };

/**
 * Incremental, request-local adapter. Ordinary text is not buffered; only an incomplete
 * delimiter/run or a backslash-delimited formula is retained (at most 64 KiB).
 * Code spans/fences are opaque. Unmatched/oversized formulas fail open as literal text,
 * never by inventing a closing delimiter. This is not a general TeX or Markdown parser.
 */
export class MathMarkdownStream {
  private pending = '';
  private formula: { close: string; raw: string; bytes: number; line: number } | undefined;
  private fence: Fence | undefined;
  private ticks = 0;
  private dollars = 0;
  // 0..4 = indentation at the start of an input line; 5 = non-prefix content.
  private line = 0;
  private indented = false;
  private prefix = '';
  private literal = false;

  push(value: string): string { return this.consume(value, false); }
  finish(): string { return this.consume('', true); }

  private advance(value: string): void {
    for (const char of value) {
      if (char === '\n') {
        if (this.fence?.closing) this.fence = undefined;
        this.line = 0; this.indented = false; this.prefix = '';
      } else {
        this.prefix = this.prefix.length < 256 ? this.prefix + char : '!';
        if (this.fence?.closing && char !== ' ' && char !== '\t' && char !== '\r') this.fence.closing = false;
        if ((char === ' ' && this.line === 3) || (char === '\t' && this.line <= 4)) this.indented = true;
        this.line = char === ' ' && this.line <= 4 ? Math.min(4, this.line + 1) : 5;
      }
    }
  }

  private consume(value: string, final: boolean): string {
    if (this.literal) return value;
    this.pending += value;
    let out = ''; let index = 0;
    const take = (text: string) => { this.advance(text); index += text.length; };
    while (index < this.pending.length) {
      const char = this.pending[index]!;
      if (this.formula) {
        if (char === '\\' && index + 1 === this.pending.length && !final) break;
        const token = char === '\\' ? this.pending.slice(index, index + 2) : char;
        const formula = this.formula;
        if (token === formula.close) {
          const body = formula.raw.slice(2);
          // Copilot's inline math tokenizer is single-line; preserve multiline \(...\).
          out += formula.close === '\\)'
            ? (/\r|\n/.test(body) || !body.trim() || body.includes('$') ? formula.raw + token : `$${body}$`)
            : (!body.trim() || body.includes('$') ? formula.raw + token
              : `${formula.line === 0 ? '' : '\n'}$$${/^\r?\n/.test(body) ? '' : '\n'}${body}${/\n$/.test(body) ? '' : '\n'}$$\n`);
          this.formula = undefined;
        } else {
          formula.raw += token;
          // Counting split surrogate halves separately is conservative, never an underestimate.
          formula.bytes += Buffer.byteLength(token);
        }
        take(token);
        if (this.formula && this.formula.bytes > MAX_PENDING) {
          // Keep the entire remaining response literal after an oversized candidate.
          out += this.formula.raw + this.pending.slice(index);
          this.formula = undefined; this.pending = ''; this.literal = true; return out;
        }
        continue;
      }
      if (this.indented && !this.fence && !this.ticks && !this.dollars) {
        out += char; take(char); continue;
      }
      if (char === '`' || char === '~' || char === '$') {
        let end = index + 1;
        while (this.pending[end] === char) end++;
        if (end - index > MAX_PENDING) {
          out += this.pending.slice(index); this.pending = ''; this.literal = true; return out;
        }
        if (end === this.pending.length && !final) break;
        const run = this.pending.slice(index, end);
        // Also protect fences nested in ordinary blockquotes/list items. Keep the
        // prefix bounded; deeply nested or ambiguous Markdown is not reparsed.
        const fencePrefix = /^(?: {0,3}>[ \t]?)*(?:[ \t]*(?:[-+*]|\d{1,9}[.)])[ \t]+)?[ \t]*$/.test(this.prefix);
        const inFence = !!this.fence;
        // Advance before marking a candidate close, so the closing run itself does
        // not invalidate it. Only whitespace may follow a closing fence.
        take(run); out += run;
        if (inFence) {
          if (fencePrefix && char === this.fence!.marker && run.length >= this.fence!.length) this.fence!.closing = true;
        } else if (!this.ticks && !this.dollars && fencePrefix && char !== '$' && run.length >= 3) {
          this.fence = { marker: char, length: run.length, closing: false };
        } else if (char === '`' && !this.dollars) {
          if (!this.ticks) this.ticks = run.length;
          else if (this.ticks === run.length) this.ticks = 0;
        } else if (char === '$' && !this.ticks) {
          if (!this.dollars) this.dollars = run.length;
          else if (this.dollars === run.length) this.dollars = 0;
        }
        continue;
      }
      if (char === '\\' && !this.fence && !this.ticks && !this.indented) {
        if (index + 1 === this.pending.length && !final) break;
        const token = this.pending.slice(index, index + 2);
        if (!this.dollars && (token === '\\(' || token === '\\[')) {
          this.formula = { close: token === '\\(' ? '\\)' : '\\]', raw: token, bytes: 2, line: this.line };
        } else out += token;
        take(token); continue;
      }
      out += char; take(char);
    }
    this.pending = this.pending.slice(index);
    if (this.pending.length > MAX_PENDING) {
      out += this.pending; this.pending = ''; this.literal = true;
    }
    if (final && this.formula) {
      out += this.formula.raw; this.formula = undefined;
    }
    return out;
  }
}
