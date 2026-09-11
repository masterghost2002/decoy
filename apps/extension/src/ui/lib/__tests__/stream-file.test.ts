import { describe, expect, it } from 'vitest';

import { streamFormatForFile } from '@/ui/lib/stream-file';

describe('streamFormatForFile', () => {
  it('reads the format off an unambiguous extension', () => {
    expect(streamFormatForFile('capture.ndjson', '')).toBe('ndjson');
    expect(streamFormatForFile('capture.jsonl', '')).toBe('ndjson');
    expect(streamFormatForFile('events.sse', '')).toBe('sse');
    expect(streamFormatForFile('notes.txt', '')).toBe('text');
  });

  it('recognizes an sse capture by its first field', () => {
    expect(streamFormatForFile('capture.log', 'data: {"n":1}\n\ndata: {"n":2}\n\n')).toBe('sse');
    expect(streamFormatForFile('capture.log', 'event: ping\ndata: {}\n\n')).toBe('sse');
  });

  it('recognizes ndjson from consecutive json records', () => {
    expect(streamFormatForFile('capture.log', '{"n":1}\n{"n":2}\n{"n":3}\n')).toBe('ndjson');
  });

  it('leaves the choice alone when the file is not plain', () => {
    // One json document is a body, not a stream of records.
    expect(streamFormatForFile('body.json', '{\n  "n": 1\n}')).toBeNull();
    expect(streamFormatForFile('mystery', 'hello there')).toBeNull();
    expect(streamFormatForFile('mystery', '')).toBeNull();
  });
});
