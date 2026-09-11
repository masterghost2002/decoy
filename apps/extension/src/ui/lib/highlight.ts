/**
 * Tokenizers for the two languages this product asks people to type: the JSON
 * of a response body, and the JavaScript of a handler.
 *
 * Hand-written rather than pulled in. A highlighter is one of the few things
 * where a dependency looks obviously right and is not: the smallest credible
 * one is larger than this entire extension's UI bundle, it arrives with a theme
 * that has to be fought rather than configured, and it would run inside a
 * content script injected into every page on the web. What is actually needed
 * is four colours and a tokenizer that never throws on half-typed input --
 * which is most of the time, because this text is being edited.
 *
 * Two rules hold everywhere below:
 *
 *  1. **Every character is emitted exactly once.** The coloured layer is
 *     rendered behind a transparent textarea and has to line up with it
 *     character for character; dropping or duplicating one shifts the rest of
 *     the document sideways.
 *  2. **Unterminated anything is fine.** A string with no closing quote is what
 *     every string looks like halfway through being typed, and it colours to
 *     the end of the line rather than throwing the rest of the file off.
 */

export type TokenKind =
  | 'plain'
  | 'key'
  | 'string'
  | 'number'
  | 'keyword'
  | 'comment'
  | 'punctuation';

export interface Token {
  text: string;
  kind: TokenKind;
}

/** Merged as they are produced: one span per run, not one per character. */
function push(tokens: Token[], text: string, kind: TokenKind): void {
  if (text.length === 0) return;
  const last = tokens[tokens.length - 1];
  if (last !== undefined && last.kind === kind) {
    last.text += text;
    return;
  }
  tokens.push({ text, kind });
}

/** Reads a quoted string from `at`, tolerating escapes and a missing end quote. */
function readString(source: string, at: number, quote: string): number {
  let index = at + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    // A newline ends an unterminated single or double quoted string, which is
    // what a half-typed one looks like. Template literals may span lines.
    if (char === '\n' && quote !== '`') return index;
    index += 1;
  }
  return source.length;
}

const NUMBER = /^-?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/;

export function tokenizeJson(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? '';

    if (char === '"') {
      const end = readString(source, index, '"');
      const text = source.slice(index, end);
      // A string is a key when the next thing that is not whitespace is a
      // colon. That is the whole difference, and it is worth colouring: it is
      // how you see at a glance that a body has the shape you meant.
      const rest = source.slice(end);
      const isKey = /^\s*:/.test(rest);
      push(tokens, text, isKey ? 'key' : 'string');
      index = end;
      continue;
    }

    const remainder = source.slice(index);
    const literal = /^(?:true|false|null)\b/.exec(remainder);
    if (literal !== null) {
      push(tokens, literal[0], 'keyword');
      index += literal[0].length;
      continue;
    }

    const number = NUMBER.exec(remainder);
    if (number !== null) {
      push(tokens, number[0], 'number');
      index += number[0].length;
      continue;
    }

    if ('{}[]:,'.includes(char)) {
      push(tokens, char, 'punctuation');
      index += 1;
      continue;
    }

    push(tokens, char, 'plain');
    index += 1;
  }

  return tokens;
}

const JS_KEYWORDS = new Set([
  'async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger',
  'default', 'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from',
  'function', 'if', 'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'static',
  'super', 'switch', 'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'yield',
  'true', 'false', 'null', 'undefined',
]);

/**
 * The handler API itself, coloured like the language.
 *
 * Not decoration: `req`, `res`, `next` and `store` are the entire contract, and
 * seeing them light up is how someone learns they are already in scope without
 * reading anything.
 */
const JS_PROVIDED = new Set(['req', 'res', 'next', 'store', 'console']);

const IDENTIFIER = /^[A-Za-z_$][\w$]*/;

export function tokenizeJs(source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;

  while (index < source.length) {
    const char = source[index] ?? '';
    const next = source[index + 1] ?? '';

    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', index);
      const stop = end === -1 ? source.length : end;
      push(tokens, source.slice(index, stop), 'comment');
      index = stop;
      continue;
    }

    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      const stop = end === -1 ? source.length : end + 2;
      push(tokens, source.slice(index, stop), 'comment');
      index = stop;
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      const end = readString(source, index, char);
      push(tokens, source.slice(index, end), 'string');
      index = end;
      continue;
    }

    const remainder = source.slice(index);

    const number = NUMBER.exec(remainder);
    if (number !== null && !/[\w$]/.test(source[index - 1] ?? '')) {
      push(tokens, number[0], 'number');
      index += number[0].length;
      continue;
    }

    const word = IDENTIFIER.exec(remainder);
    if (word !== null) {
      const name = word[0];
      // `res.status` is a property, not the provided `status`; only a bare
      // occurrence counts.
      const afterDot = source[index - 1] === '.';
      const kind: TokenKind =
        JS_KEYWORDS.has(name) && !afterDot
          ? 'keyword'
          : JS_PROVIDED.has(name) && !afterDot
            ? 'key'
            : 'plain';
      push(tokens, name, kind);
      index += name.length;
      continue;
    }

    if ('{}[]();,.:?=<>!+-*/%&|^~'.includes(char)) {
      push(tokens, char, 'punctuation');
      index += 1;
      continue;
    }

    push(tokens, char, 'plain');
    index += 1;
  }

  return tokens;
}

export type CodeLanguage = 'json' | 'js' | 'none';

export function tokenize(language: CodeLanguage, source: string): Token[] {
  if (language === 'json') return tokenizeJson(source);
  if (language === 'js') return tokenizeJs(source);
  return source.length === 0 ? [] : [{ text: source, kind: 'plain' }];
}
