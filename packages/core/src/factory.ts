import type { ConditionSource, RuleCondition } from './conditions.js';
import { DEFAULT_HANDLER_TIMEOUT_MS } from './handler.js';
import { createId } from './id.js';
import { METHOD_ANY } from './http.js';
import type {
  MockRule,
  NetworkErrorType,
  RuleAction,
  StreamChunk,
  StreamFormat,
} from './rule.js';

export function createRespondAction(status = 200): Extract<RuleAction, { kind: 'respond' }> {
  return {
    kind: 'respond',
    status,
    statusText: '',
    headers: [],
    body: { type: 'json', value: '{}' },
    delayMs: 0,
  };
}

export function createStreamChunk(value = ''): StreamChunk {
  return { id: createId('chunk'), value };
}

/* -------------------------------------------------------------------------- */
/* A file, turned into chunks                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Ceilings on a stream loaded from a file. The whole config lives in
 * `chrome.storage.local` under one key, so a dropped-in log file is not allowed
 * to grow a rule past the point where anything can be saved at all.
 */
export const MAX_CHUNK_SOURCE_CHARS = 256 * 1024;
export const MAX_CHUNKS_FROM_TEXT = 500;

export interface ChunksFromText {
  chunks: StreamChunk[];
  /** Pieces past `MAX_CHUNKS_FROM_TEXT`, which were left out. */
  omitted: number;
  /** True when the text was cut at `MAX_CHUNK_SOURCE_CHARS` before splitting. */
  truncated: boolean;
}

/**
 * Splits a file into the pieces the format sends, one chunk each.
 *
 * The split is the inverse of `encodeStreamChunk`: it cuts exactly where that
 * function puts the framing back, so loading a captured stream and playing it
 * out reproduces the file rather than a rearrangement of it.
 *
 *  - `sse` cuts on the blank line that ends an event, keeping a multi-line
 *    `event:` / `data:` pair together in one chunk.
 *  - `ndjson` cuts per line, because one line is one record.
 *  - `text` cuts per line but *keeps* the newline, since nothing is inserted
 *    between text chunks and dropping it would land the whole file on one line.
 */
export function chunksFromText(format: StreamFormat, text: string): ChunksFromText {
  const truncated = text.length > MAX_CHUNK_SOURCE_CHARS;
  const source = truncated ? text.slice(0, MAX_CHUNK_SOURCE_CHARS) : text;

  const pieces = splitForFormat(format, source);
  const kept = pieces.slice(0, MAX_CHUNKS_FROM_TEXT);

  return {
    chunks: kept.map((value) => createStreamChunk(value)),
    omitted: pieces.length - kept.length,
    truncated,
  };
}

function splitForFormat(format: StreamFormat, text: string): string[] {
  // Normalized first: a file written on Windows would otherwise leave a stray
  // carriage return at the end of every record.
  const normalized = text.replace(/\r\n/g, '\n');

  if (format === 'text') {
    return normalized.split(/(?<=\n)/).filter((piece) => piece.length > 0);
  }

  const boundary = format === 'sse' ? /\n[ \t]*\n/ : /\n/;
  return normalized
    .split(boundary)
    .map((piece) => piece.trim())
    .filter((piece) => piece.length > 0);
}

/**
 * Defaults to a repeating SSE ping every half second. Server-sent events are
 * what people reach for a stream mock to reproduce, and a stream that sends one
 * chunk and stops would look identical to a plain response.
 */
export function createStreamAction(): Extract<RuleAction, { kind: 'stream' }> {
  return {
    kind: 'stream',
    status: 200,
    statusText: '',
    headers: [],
    format: 'sse',
    chunks: [
      createStreamChunk('{"type": "message", "n": 1}'),
      createStreamChunk('{"type": "message", "n": 2}'),
    ],
    delayMs: 0,
    intervalMs: 500,
    repeat: 1,
  };
}

/**
 * The starter handler. It is deliberately a working, readable example rather
 * than an empty box: the whole contract -- what `req` carries, the two ways to
 * answer, and that falling through is a choice -- is visible in eight lines,
 * which is a better introduction than any amount of documentation beside it.
 */
export const STARTER_HANDLER_CODE = `// req: method, url, path, query, params, headers, cookies, body
// res: status(), set(), json(), text(), stream(), fail(), passthrough()
// store: survives between requests. next(): let the rules below decide.

if (req.method === 'POST') {
  const sent = JSON.parse(req.body ?? '{}');
  return res.status(201).json({ id: 'u_1', ...sent });
}

store.hits = (store.hits ?? 0) + 1;
return { page: Number(req.query.page ?? 1), hits: store.hits, items: [] };
`;

export function createHandlerAction(
  code = STARTER_HANDLER_CODE,
): Extract<RuleAction, { kind: 'handler' }> {
  return { kind: 'handler', code, delayMs: 0, timeoutMs: DEFAULT_HANDLER_TIMEOUT_MS };
}

export function createNetworkErrorAction(
  errorType: NetworkErrorType = 'failed',
): Extract<RuleAction, { kind: 'networkError' }> {
  return { kind: 'networkError', errorType, delayMs: 0 };
}

/** A blank rule for the editor. Enabled, because a rule you just created and
 * cannot see working is worse than one that fires immediately. */
export function createRule(now: number, name = 'New rule'): MockRule {
  return {
    id: createId('rule'),
    name,
    enabled: true,
    matcher: {
      url: { mode: 'contains', value: '', caseSensitive: false },
      methods: [METHOD_ANY],
      conditions: [],
      conditionMode: 'all',
    },
    action: createRespondAction(200),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * A new condition starts enabled but empty-keyed, and an empty key reads as
 * absent rather than as a wildcard, so it narrows nothing until filled in.
 */
export function createCondition(source: ConditionSource = 'header'): RuleCondition {
  return {
    id: createId('cond'),
    source,
    key: '',
    operator: 'equals',
    value: '',
    caseSensitive: false,
    enabled: true,
  };
}
