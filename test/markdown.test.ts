import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MathMarkdownStream } from '../src/chat/markdown';

function render(chunks: string[]): string {
  const stream = new MathMarkdownStream();
  return chunks.map(chunk => stream.push(chunk)).join('') + stream.finish();
}
const cases: [string, string, string][] = [
  ['inline math', String.raw`Euler: \(e^{i\pi}+1=0\).`, 'Euler: $e^{i\\pi}+1=0$.'],
  ['display math', String.raw`\[\frac{a}{b}\]`, '$$\n\\frac{a}{b}\n$$\n'],
  ['display between prose', String.raw`Before \[x^2\] after.`, 'Before \n$$\nx^2\n$$\n after.'],
  ['multiline display', '\\[\n  x + y = z\n\\]', '$$\n  x + y = z\n$$\n'],
  ['TeX whitespace is preserved', String.raw`\[x\ \]`, '$$\nx\\ \n$$\n'],
  ['Chinese and Unicode', String.raw`公式 \(α+β=γ\)，继续。`, '公式 $α+β=γ$，继续。'],
  ['native math', String.raw`$x$ and $$\frac{a}{b}$$`, String.raw`$x$ and $$\frac{a}{b}$$`],
  ['native math containing escaped delimiters', String.raw`$\text{\(literal\)}$`, String.raw`$\text{\(literal\)}$`],
  ['code spans', '`\\(x\\)` and ``a ` \\[y\\]`` then \\(z\\)', '`\\(x\\)` and ``a ` \\[y\\]`` then $z$'],
  ['backtick fences', '```latex\n\\[x\\]\n```\n\\(y\\)', '```latex\n\\[x\\]\n```\n$y$'],
  ['tilde fences', '~~~latex\n\\(x\\)\n~~~\n\\(y\\)', '~~~latex\n\\(x\\)\n~~~\n$y$'],
  ['quoted tilde fences', '> ~~~tex\n> ` \\(x\\)\n> ~~~\n\\(y\\)', '> ~~~tex\n> ` \\(x\\)\n> ~~~\n$y$'],
  ['list fences', '- ```tex\n  \\(x\\)\n  ```\n\\(y\\)', '- ```tex\n  \\(x\\)\n  ```\n$y$'],
  ['long fences', '````\n```\n\\(x\\)\n````\n\\(y\\)', '````\n```\n\\(x\\)\n````\n$y$'],
  ['indented fences and CRLF', '  ```latex\r\n\\[x\\]\r\n  ``` \r\n\\(y\\)', '  ```latex\r\n\\[x\\]\r\n  ``` \r\n$y$'],
  ['invalid fence close', '```\n```not a close\n\\(x\\)\n```\n\\(y\\)', '```\n```not a close\n\\(x\\)\n```\n$y$'],
  ['indented code', '    \\(x\\) `\n\t\\[y\\]\n\\(z\\)', '    \\(x\\) `\n\t\\[y\\]\n$z$'],
  ['escaped delimiters', String.raw`\\(x\\) and \\[y\\] and \(z\)`, String.raw`\\(x\\) and \\[y\\] and $z$`],
  ['unmatched delimiters', String.raw`Start \(x and \[y`, String.raw`Start \(x and \[y`],
  ['unmatched closing delimiters', String.raw`x\) y\]`, String.raw`x\) y\]`],
  ['empty formulas', String.raw`\(\) and \[ \]`, String.raw`\(\) and \[ \]`],
  ['multiline inline formula', '\\(x\ny\\)', '\\(x\ny\\)'],
  ['dollar in formula', String.raw`\(\text{cost $5}\)`, String.raw`\(\text{cost $5}\)`],
  ['literal trailing backslash', 'end\\', 'end\\'],
  ['literal trailing ticks', 'end``', 'end``'],
];
for (const [name, input, expected] of cases) test(`math Markdown: ${name}, independent of chunk boundaries`, () => {
  assert.equal(render([input]), expected);
  assert.equal(render([...input]), expected);
  for (let split = 0; split <= input.length; split++) assert.equal(render([input.slice(0, split), input.slice(split)]), expected, `split at ${split}`);
});

test('ordinary prose streams immediately; only incomplete math is delayed', () => {
  const stream = new MathMarkdownStream();
  assert.equal(stream.push('Normal text '), 'Normal text ');
  assert.equal(stream.push('\\'), '');
  assert.equal(stream.push('(x'), '');
  assert.equal(stream.push(' + y\\'), '');
  assert.equal(stream.push(') done'), '$x + y$ done');
  assert.equal(stream.finish(), '');
});
test('oversized formula/run falls back to literal output without truncation', () => {
  for (const input of ['\\(' + 'x'.repeat(65540) + '\\) then \\(y\\)', '\\(' + '数'.repeat(22000) + '\\) then \\(y\\)', '`'.repeat(65540) + '\\(x\\)']) {
    assert.equal(render([input]), input);
    assert.equal(render([input.slice(0, 65538), input.slice(65538)]), input);
  }
});
test('state is local to one stream; finalization does not invent math or code closers', () => {
  assert.equal(render(['\\(unfinished']), '\\(unfinished');
  assert.equal(render(['\\(new\\)']), '$new$');
  assert.equal(render(['```\n\\(code']), '```\n\\(code');
});
