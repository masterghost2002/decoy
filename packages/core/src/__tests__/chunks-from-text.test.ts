import { describe, expect, it } from 'vitest';

import {
  MAX_CHUNKS_FROM_TEXT,
  MAX_CHUNK_SOURCE_CHARS,
  chunksFromText,
} from '../factory.js';
import { encodeStreamChunk } from '../resolve.js';
import type { StreamFormat } from '../rule.js';

/** What the caller would actually receive off the wire. */
function played(format: StreamFormat, text: string): string {
  return chunksFromText(format, text)
    .chunks.map((chunk) => encodeStreamChunk(format, chunk.value))
    .join('');
}

describe('chunksFromText', () => {
  it('gives ndjson one chunk per record', () => {
    const result = chunksFromText('ndjson', '{"n":1}\n{"n":2}\n{"n":3}\n');
    expect(result.chunks.map((chunk) => chunk.value)).toEqual(['{"n":1}', '{"n":2}', '{"n":3}']);
  });

  it('keeps a multi-line sse event in one chunk', () => {
    const file = 'event: ping\ndata: {"n":1}\n\ndata: {"n":2}\n\n';
    expect(chunksFromText('sse', file).chunks.map((chunk) => chunk.value)).toEqual([
      'event: ping\ndata: {"n":1}',
      'data: {"n":2}',
    ]);
  });

  it('keeps the newline on a text chunk, so the file is not flattened', () => {
    const result = chunksFromText('text', 'one\ntwo\n');
    expect(result.chunks.map((chunk) => chunk.value)).toEqual(['one\n', 'two\n']);
  });

  it('plays a text file back exactly as written', () => {
    const file = 'line one\nline two\n\nline four\n';
    expect(played('text', file)).toBe(file);
  });

  it('plays an sse capture back as the same events', () => {
    const file = 'event: ping\ndata: {"n":1}\n\ndata: {"n":2}\n\n';
    expect(played('sse', file)).toBe(file);
  });

  it('plays an ndjson file back one record per line', () => {
    const file = '{"n":1}\n{"n":2}\n';
    expect(played('ndjson', file)).toBe(file);
  });

  it('normalizes windows line endings rather than trailing them into records', () => {
    expect(chunksFromText('ndjson', '{"n":1}\r\n{"n":2}\r\n').chunks[0]?.value).toBe('{"n":1}');
    expect(played('text', 'one\r\ntwo\r\n')).toBe('one\ntwo\n');
  });

  it('gives every chunk its own id', () => {
    const ids = chunksFromText('ndjson', '1\n2\n3\n').chunks.map((chunk) => chunk.id);
    expect(new Set(ids).size).toBe(3);
  });

  it('finds nothing to send in a blank file', () => {
    expect(chunksFromText('ndjson', '\n\n  \n').chunks).toEqual([]);
    expect(chunksFromText('text', '').chunks).toEqual([]);
  });

  it('reports the records it left out past the chunk ceiling', () => {
    const file = `${'x\n'.repeat(MAX_CHUNKS_FROM_TEXT + 12)}`;
    const result = chunksFromText('ndjson', file);
    expect(result.chunks).toHaveLength(MAX_CHUNKS_FROM_TEXT);
    expect(result.omitted).toBe(12);
    expect(result.truncated).toBe(false);
  });

  it('reports a file cut at the size ceiling', () => {
    const result = chunksFromText('text', 'x'.repeat(MAX_CHUNK_SOURCE_CHARS + 1));
    expect(result.truncated).toBe(true);
    expect(result.chunks[0]?.value).toHaveLength(MAX_CHUNK_SOURCE_CHARS);
  });
});
