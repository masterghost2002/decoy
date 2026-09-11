/**
 * Streams: a body that arrives in pieces rather than all at once.
 *
 * "Arrived in pieces" is the one claim a unit test cannot make, so every case
 * here reads the body incrementally and asserts on the reads themselves -- a
 * single blob would be indistinguishable from an ordinary respond rule.
 */
import {
  assert,
  assertAtLeast,
  assertEqual,
  drain,
  expectRejection,
  now,
  suite,
  waitForXhr,
} from '../harness.js';

const add = suite(
  'stream',
  'Streams',
  'Chunked bodies, framing, intervals and endless event sources.',
);

/* -------------------------------------------------------------------------- */
/* Framing                                                                    */
/* -------------------------------------------------------------------------- */

add('sse framing: a bare payload gets data:, a framed one is left alone', {
  rules: ['rule_sse'],
  async run() {
    const response = await fetch('/api/events');
    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('content-type'), 'text/event-stream', 'content-type');

    const { pieces, text } = await drain(response);
    assertAtLeast(pieces.length, 2, 'reads');
    assertEqual(text, 'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n', 'framed body');
    return `${String(pieces.length)} events, read one at a time`;
  },
});

add('an sse chunk that already names a field is passed through raw', {
  rules: ['pg_stream_raw_sse'],
  doc: 'A hand-written "event: ping" still works; only a bare payload is rewritten. Comments and retry lines survive too.',
  async run() {
    const { text } = await drain(await fetch('/pg/stream/raw-sse'));
    assertEqual(
      text,
      'event: ping\ndata: 1\n\nid: 7\n\nretry: 5000\n\n: a comment\n\ndata: {"bare":1}\n\n',
      'framed body',
    );
    return 'four raw fields untouched, one bare payload prefixed';
  },
});

add('every line of a multi-line chunk gets its own data: prefix', {
  rules: ['pg_stream_multiline'],
  doc: 'A raw newline inside an SSE data field would end the event, so each line is framed separately.',
  async run() {
    const { text } = await drain(await fetch('/pg/stream/multiline'));
    assertEqual(text, 'data: line one\ndata: line two\n\n', 'framed body');
    return 'one event, two data lines';
  },
});

add('a whitespace-only chunk is dropped rather than framed', {
  rules: ['pg_stream_blank'],
  doc: 'A blank line in SSE terminates an event that was never started. Sending it would still cost an interval, which reads as a stalled stream.',
  async run() {
    const { pieces, text } = await drain(await fetch('/pg/stream/blank'));
    assertEqual(text, 'data: {"a":1}\n\ndata: {"b":2}\n\n', 'framed body');
    assertEqual(pieces.length, 2, 'reads: the blank chunk costs no interval either');
    return 'two chunks on the wire out of three in the rule';
  },
});

add('ndjson compacts a pretty-printed record onto one line, and repeats', {
  rules: ['rule_ndjson'],
  async run() {
    const response = await fetch('/api/ndjson');
    assertEqual(response.headers.get('content-type'), 'application/x-ndjson', 'content-type');
    assertEqual(await response.text(), '{"a":1}\n{"b":2}\n{"a":1}\n{"b":2}\n', 'body');
    return 'four one-line records from two multi-line chunks, sent twice';
  },
});

add('ndjson leaves a chunk that is not json exactly as written', {
  rules: ['pg_stream_ndjson_raw'],
  doc: 'Guessing where the record boundaries are in arbitrary text would be worse than trusting the newlines already there.',
  async run() {
    const { text } = await drain(await fetch('/pg/stream/ndjson-raw'));
    assertEqual(text, '{"a":1}\nnot json at all\n', 'body');
    return 'compacted the json, left the prose alone';
  },
});

add('text framing sends each chunk verbatim', {
  rules: ['pg_stream_text'],
  async run() {
    const response = await fetch('/pg/stream/text');
    assertEqual(response.headers.get('content-type'), 'text/plain;charset=utf-8', 'content-type');
    const { text } = await drain(response);
    assertEqual(text, 'one\ntwo\n', 'body');
    return 'no framing applied at all, which is the format';
  },
});

add('an explicit content type wins over the format default', {
  rules: ['pg_stream_ct'],
  async run() {
    const response = await fetch('/pg/stream/content-type');
    assertEqual(response.headers.get('content-type'), 'text/plain;charset=utf-8', 'content-type');
    return 'the rule named it, so the format did not';
  },
});

add('204 drops the chunks rather than opening an empty stream', {
  rules: ['pg_stream_204'],
  async run() {
    const response = await fetch('/pg/stream/204');
    assertEqual(response.status, 204, 'status');
    assertEqual(response.body, null, 'response.body');
    return 'no body at all, which is what 204 requires';
  },
});

/* -------------------------------------------------------------------------- */
/* Timing                                                                     */
/* -------------------------------------------------------------------------- */

add('chunks arrive on the interval, not all at once', {
  rules: ['pg_stream_interval'],
  slow: true,
  doc: 'Four chunks 60 ms apart. The first goes out with the head, so three intervals separate the four.',
  async run() {
    const startedAt = now();
    const { pieces } = await drain(await fetch('/pg/stream/interval'));
    const elapsed = now() - startedAt;
    assertEqual(pieces.length, 4, 'reads');
    assertAtLeast(elapsed, 150, 'elapsed ms');
    return `four chunks over ${String(Math.round(elapsed))}ms`;
  },
});

add('the head waits for the delay, then the chunks follow', {
  rules: ['pg_stream_head_delay'],
  slow: true,
  async run() {
    const startedAt = now();
    const response = await fetch('/pg/stream/head-delay');
    const headAt = now() - startedAt;
    assertAtLeast(headAt, 250, 'ms before the head arrived');
    const { pieces } = await drain(response);
    assertEqual(pieces.length, 2, 'reads');
    return `head after ${String(Math.round(headAt))}ms, then two chunks`;
  },
});

add('the chunk list repeats the number of times the rule says', {
  rules: ['pg_stream_repeat'],
  async run() {
    const { text } = await drain(await fetch('/pg/stream/repeat'));
    assertEqual(text, '{"a":1}\n{"b":2}\n'.repeat(3), 'body');
    return 'two chunks, three passes, six records';
  },
});

add('repeat 0 never closes on its own', {
  rules: ['rule_forever'],
  doc: 'The honest way to mock an endpoint that is not supposed to end. Reading past the end of the chunk list keeps working; only the caller can stop it.',
  async run() {
    const controller = new AbortController();
    const response = await fetch('/api/forever', { signal: controller.signal });
    const reader = response.body.getReader();

    // Three reads out of a one-chunk list: a stream that stopped at the end of
    // its chunks would have reported done on the second.
    for (let index = 0; index < 3; index += 1) {
      const next = await reader.read();
      assertEqual(next.done, false, `read ${String(index + 1)} done`);
    }

    // Synchronously, so no already-enqueued chunk can satisfy the read below
    // before the abort reaches it.
    controller.abort();
    const error = await expectRejection(reader.read(), 'aborted stream');
    assertEqual(error.name, 'AbortError', 'error.name');
    return 'the body never closed itself; abort ended it';
  },
});

add('cancelling the reader stops the timers behind the stream', {
  rules: ['pg_stream_endless'],
  doc: 'A stream nobody is reading should not keep a timer alive for the life of the page.',
  async run() {
    const response = await fetch('/pg/stream/endless');
    const reader = response.body.getReader();
    await reader.read();
    await reader.cancel();
    assertEqual(response.bodyUsed, true, 'bodyUsed after cancel');
    return 'cancelled cleanly, with no error raised';
  },
});

/* -------------------------------------------------------------------------- */
/* Over XHR                                                                   */
/* -------------------------------------------------------------------------- */

add('an xhr sees a stream grow through responseText', {
  rules: ['rule_sse'],
  doc: 'XHR has no ReadableStream, so chunks surface as progress events with responseText growing underneath them.',
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/events');

    let loadingTicks = 0;
    let sawPartial = false;
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState !== 3) return;
      loadingTicks += 1;
      if (xhr.responseText.length > 0 && !xhr.responseText.includes('[DONE]')) sawPartial = true;
    });
    xhr.send();

    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'load', 'event');
    assertEqual(xhr.status, 200, 'status');
    assertAtLeast(loadingTicks, 2, 'LOADING ticks');
    assert(sawPartial, 'responseText should be readable before the stream finishes');
    assertEqual(
      xhr.responseText,
      'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n',
      'responseText',
    );
    return `chunks surfaced across ${String(loadingTicks)} progress ticks`;
  },
});

add('progress events report how much has arrived', {
  rules: ['pg_stream_interval'],
  slow: true,
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/stream/interval');
    const loaded = [];
    xhr.addEventListener('progress', (event) => {
      loaded.push(event.loaded);
    });
    xhr.send();
    await waitForXhr(xhr);

    assertAtLeast(loaded.length, 2, 'progress events');
    assert(
      loaded.every((value, index) => index === 0 || value >= loaded[index - 1]),
      `loaded should never go backwards: ${JSON.stringify(loaded)}`,
    );
    return `${String(loaded.length)} progress events, monotonic`;
  },
});

add('an xhr timeout cuts off a body that had already started arriving', {
  rules: ['pg_stream_slow'],
  slow: true,
  doc: 'A mocked xhr never touches the network, so the platform timeout would never fire. Decoy emulates it, including mid-stream.',
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/stream/slow');
    xhr.timeout = 400;
    let sawSomething = false;
    xhr.addEventListener('readystatechange', () => {
      if (xhr.readyState === 3 && xhr.responseText.length > 0) sawSomething = true;
    });
    xhr.send();

    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'timeout', 'event');
    assert(sawSomething, 'part of the body should have arrived before the timeout');
    return 'a partial body, then a timeout event';
  },
});

add('aborting an xhr mid-stream stops it', {
  rules: ['pg_stream_endless'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/stream/endless');
    xhr.send();
    await new Promise((resolve) => {
      xhr.addEventListener('progress', resolve, { once: true });
    });
    xhr.abort();
    assertEqual(xhr.readyState, 0, 'readyState after abort');
    return 'the endless stream was ended by the caller';
  },
});
