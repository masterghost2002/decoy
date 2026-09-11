import { describe, expect, it } from 'vitest';

import { tokenize, tokenizeJs, tokenizeJson, type Token } from '@/ui/lib/highlight';

/** The invariant the coloured layer depends on: every character, exactly once. */
function assertLossless(tokens: Token[], source: string): void {
  expect(tokens.map((token) => token.text).join('')).toBe(source);
}

const kinds = (tokens: Token[]) => tokens.map((token) => `${token.kind}:${token.text}`);

describe('tokenizeJson', () => {
  it('tells a key from a string by the colon that follows it', () => {
    const source = '{"name": "Ada"}';
    const tokens = tokenizeJson(source);
    assertLossless(tokens, source);
    expect(kinds(tokens)).toEqual([
      'punctuation:{',
      'key:"name"',
      'punctuation:,:'.replace(',', ''),
      'plain: ',
      'string:"Ada"',
      'punctuation:}',
    ]);
  });

  it('still calls it a key when the colon is on the next line', () => {
    expect(tokenizeJson('{"a"\n: 1}')[1]).toEqual({ text: '"a"', kind: 'key' });
  });

  it('colours numbers, booleans and null', () => {
    const source = '[1, -2.5, 1e3, true, false, null]';
    const tokens = tokenizeJson(source);
    assertLossless(tokens, source);
    expect(tokens.filter((token) => token.kind === 'number').map((t) => t.text)).toEqual([
      '1',
      '-2.5',
      '1e3',
    ]);
    expect(tokens.filter((token) => token.kind === 'keyword').map((t) => t.text)).toEqual([
      'true',
      'false',
      'null',
    ]);
  });

  it('keeps an escaped quote inside the string', () => {
    const source = '{"q": "say \\"hi\\""}';
    assertLossless(tokenizeJson(source), source);
    expect(tokenizeJson(source).some((token) => token.text === '"say \\"hi\\""')).toBe(true);
  });

  it('survives a string that is still being typed', () => {
    // Every string looks like this halfway through. It must colour to the end
    // of the line rather than throwing the rest of the document off.
    const source = '{"name": "Ad\n  "age": 3}';
    assertLossless(tokenizeJson(source), source);
  });

  it('loses nothing on a torn-up document', () => {
    const source = '{,,[[""":::---\n\t}}';
    assertLossless(tokenizeJson(source), source);
  });

  it('emits nothing for nothing', () => {
    expect(tokenizeJson('')).toEqual([]);
  });
});

describe('tokenizeJs', () => {
  it('colours keywords, strings, numbers and comments', () => {
    const source = "// note\nconst a = 'x' + 42;";
    const tokens = tokenizeJs(source);
    assertLossless(tokens, source);
    expect(kinds(tokens)).toContain('comment:// note');
    expect(kinds(tokens)).toContain('keyword:const');
    expect(kinds(tokens)).toContain("string:'x'");
    expect(kinds(tokens)).toContain('number:42');
  });

  it('marks the handler API, which is the whole contract', () => {
    const tokens = tokenizeJs('return res.status(201).json(req.query);');
    const provided = tokens.filter((token) => token.kind === 'key').map((token) => token.text);
    expect(provided).toEqual(['res', 'req']);
  });

  it('does not colour a property that shares a provided name', () => {
    // `payload.res` is not the `res` this handler was given.
    const tokens = tokenizeJs('payload.res');
    expect(tokens.every((token) => token.kind !== 'key')).toBe(true);
  });

  it('handles a block comment, terminated or not', () => {
    assertLossless(tokenizeJs('/* a */ b'), '/* a */ b');
    assertLossless(tokenizeJs('/* never closed'), '/* never closed');
    expect(tokenizeJs('/* never closed')[0]?.kind).toBe('comment');
  });

  it('lets a template literal span lines', () => {
    const source = 'const t = `line one\nline two`;';
    assertLossless(tokenizeJs(source), source);
    expect(tokenizeJs(source).some((token) => token.text.includes('line two'))).toBe(true);
  });

  it('loses nothing on the starter handler', () => {
    const source = [
      "if (req.method === 'POST') {",
      '  const sent = JSON.parse(req.body ?? \'{}\');',
      "  return res.status(201).json({ id: 'u_1', ...sent });",
      '}',
      'store.hits = (store.hits ?? 0) + 1;',
    ].join('\n');
    assertLossless(tokenizeJs(source), source);
  });
});

describe('tokenize', () => {
  it('passes plain text through in one piece', () => {
    expect(tokenize('none', 'hello there')).toEqual([{ text: 'hello there', kind: 'plain' }]);
    expect(tokenize('none', '')).toEqual([]);
  });
});
