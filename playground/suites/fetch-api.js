/**
 * The fetch surface itself: every input shape, every response reader, and the
 * platform behaviours a mock has to keep faithful.
 *
 * A mock that is more forgiving than the network hides bugs instead of finding
 * them, so these assert the awkward parts -- bodyUsed, clone, response.type,
 * an already-used body -- rather than only the happy path.
 */
import {
  assert,
  assertAtLeast,
  assertEqual,
  assertIncludes,
  expectRejection,
  now,
  suite,
} from '../harness.js';

const add = suite(
  'fetch',
  'fetch()',
  'Input shapes, the Response surface, signals and concurrency.',
);

/* -------------------------------------------------------------------------- */
/* Inputs                                                                     */
/* -------------------------------------------------------------------------- */

add('a relative url, an absolute url and a URL object all match the same rule', {
  rules: ['pg_plain'],
  async run() {
    const relative = await fetch('/pg/plain');
    const absolute = await fetch(`${location.origin}/pg/plain`);
    const object = await fetch(new URL('/pg/plain', location.origin));
    for (const [label, response] of [
      ['relative', relative],
      ['absolute', absolute],
      ['URL', object],
    ]) {
      assertEqual(response.status, 200, `${label} status`);
      assertEqual((await response.json()).plain, true, `${label} body`);
    }
    return 'all three normalize to the same absolute url before matching';
  },
});

add('a Request object is accepted, and its method and headers are read', {
  rules: ['pg_echo'],
  async run() {
    const request = new Request('/pg/echo?from=request', {
      method: 'POST',
      headers: { 'X-From': 'request-object' },
      body: 'payload',
    });
    const body = await (await fetch(request)).json();
    assertEqual(body.method, 'POST', 'method');
    assertEqual(body.headers['x-from'], 'request-object', 'header');
    assertEqual(body.body, 'payload', 'body');
    assertEqual(body.query.from, 'request', 'query');
    return 'everything came off the Request, not off an init that was not there';
  },
});

add('init headers override the ones on a Request', {
  rules: ['pg_echo'],
  async run() {
    const request = new Request('/pg/echo', { headers: { 'X-Which': 'request' } });
    const body = await (await fetch(request, { headers: { 'X-Which': 'init' } })).json();
    assertEqual(body.headers['x-which'], 'init', 'which header won');
    return 'the init wins, as the platform specifies';
  },
});

add('options the mock cannot honour do not break it', {
  rules: ['pg_plain'],
  doc: 'credentials, mode, cache, keepalive, redirect and referrerPolicy all describe a network request that is never made. They must be ignored, not rejected.',
  async run() {
    const response = await fetch('/pg/plain', {
      credentials: 'include',
      mode: 'cors',
      cache: 'no-store',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
      keepalive: true,
      integrity: '',
    });
    assertEqual(response.status, 200, 'status');
    return 'seven ignored options, one intact mock';
  },
});

add('a data: url is left entirely alone', {
  rules: [],
  doc: 'Not an http request at all. The patch has to pass it through without trying to match or log it.',
  async run() {
    const response = await fetch('data:text/plain,decoy');
    assertEqual(await response.text(), 'decoy', 'body');
    return 'the platform answered it, as it should';
  },
});

add('a blob: url is left alone too', {
  rules: [],
  async run() {
    const url = URL.createObjectURL(new Blob(['from a blob']));
    try {
      assertEqual(await (await fetch(url)).text(), 'from a blob', 'body');
    } finally {
      URL.revokeObjectURL(url);
    }
    return 'object urls are not network urls';
  },
});

/* -------------------------------------------------------------------------- */
/* The Response                                                               */
/* -------------------------------------------------------------------------- */

add('response.url is the url that was asked for', {
  rules: ['pg_plain'],
  doc: 'A constructed Response has an empty url. Application code reads it for redirect checks and error reporting, so it is filled in.',
  async run() {
    const response = await fetch('/pg/plain?trailing=1');
    assertIncludes(response.url, '/pg/plain?trailing=1', 'response.url');
    assertEqual(response.type, 'default', 'response.type');
    assertEqual(response.redirected, false, 'response.redirected');
    return 'url, type and redirected all readable';
  },
});

add('headers iterate, not just get', {
  rules: ['pg_plain'],
  async run() {
    const response = await fetch('/pg/plain');
    const names = [...response.headers.keys()];
    assert(names.includes('x-plain'), `expected x-plain among ${JSON.stringify(names)}`);
    const collected = {};
    response.headers.forEach((value, name) => {
      collected[name] = value;
    });
    assertEqual(collected['x-count'], '1', 'forEach');
    assertEqual([...response.headers.entries()].length, names.length, 'entries matches keys');
    return `${String(names.length)} headers, enumerable every way`;
  },
});

add('clone() gives two readable copies of one mocked body', {
  rules: ['pg_plain'],
  async run() {
    const response = await fetch('/pg/plain');
    const copy = response.clone();
    assertEqual((await response.json()).n, 1, 'original');
    assertEqual((await copy.json()).n, 1, 'clone');
    return 'the body was teed, not consumed twice';
  },
});

add('reading a body twice throws, exactly as the platform does', {
  rules: ['pg_plain'],
  async run() {
    const response = await fetch('/pg/plain');
    await response.text();
    assertEqual(response.bodyUsed, true, 'bodyUsed');
    const error = await expectRejection(response.text(), 'second read');
    assert(error instanceof TypeError, `expected TypeError, got ${String(error)}`);
    return 'a mock that was more forgiving than the network would hide bugs';
  },
});

add('every body reader works on a mocked response', {
  rules: ['pg_plain'],
  async run() {
    const json = await (await fetch('/pg/plain')).json();
    assertEqual(json.plain, true, 'json()');

    const text = await (await fetch('/pg/plain')).text();
    assertEqual(text, '{"plain":true,"n":1}', 'text()');

    const buffer = await (await fetch('/pg/plain')).arrayBuffer();
    assertEqual(buffer.byteLength, text.length, 'arrayBuffer()');

    const blob = await (await fetch('/pg/plain')).blob();
    assertEqual(blob.size, text.length, 'blob()');
    assertEqual(await blob.text(), text, 'blob text');

    const bytes = await (await fetch('/pg/plain')).bytes?.();
    if (bytes !== undefined) assertEqual(bytes.length, text.length, 'bytes()');
    return 'json, text, arrayBuffer, blob and bytes';
  },
});

add('formData() refuses a body the content type does not describe', {
  rules: ['pg_respond_text'],
  doc: 'The reader follows the content type, so this is really a test that the content type a rule sets is the one the platform sees.',
  async run() {
    const response = await fetch('/pg/respond/text');
    const error = await expectRejection(response.formData(), 'formData on text/plain');
    assert(error instanceof TypeError, `expected a TypeError, got ${String(error)}`);
    return 'text/plain is not form data, and the platform says so';
  },
});

add('response.body is a real ReadableStream that can be piped', {
  rules: ['pg_respond_big'],
  async run() {
    const response = await fetch('/pg/respond/big');
    const piped = response.body.pipeThrough(new TextDecoderStream());
    const reader = piped.getReader();
    let length = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
    }
    assertAtLeast(length, 40 * 1024, 'piped length');
    return `${String(Math.round(length / 1024))} kB through a TransformStream`;
  },
});

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                */
/* -------------------------------------------------------------------------- */

add('ten concurrent mocked requests all resolve independently', {
  rules: ['pg_echo'],
  async run() {
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => fetch(`/pg/echo?i=${String(index)}`)),
    );
    const bodies = await Promise.all(responses.map((response) => response.json()));
    for (const [index, body] of bodies.entries()) {
      assertEqual(body.query.i, String(index), `response ${String(index)} matched its request`);
    }
    return 'no crosstalk between ten in-flight handler calls';
  },
});

add('a mocked and a real request in the same Promise.all do not interfere', {
  rules: ['pg_plain'],
  async run() {
    const [mock, real] = await Promise.all([fetch('/pg/plain'), fetch('/api/ping')]);
    assertEqual((await mock.json()).plain, true, 'the mocked one');
    assertEqual((await real.json()).pong, true, 'the real one');
    return 'one of each, at once';
  },
});

/* -------------------------------------------------------------------------- */
/* Cross-origin                                                               */
/* -------------------------------------------------------------------------- */

add('a cross-origin mock needs no CORS headers, because no request is made', {
  rules: ['pg_cors_mocked'],
  doc: 'The control case next to it is the proof: the same server, with no rule, genuinely refuses. Mocking happens before the request exists, so the browser has nothing to block.',
  async run() {
    const altOrigin = window.__decoyPlayground?.altOrigin;
    assert(typeof altOrigin === 'string', 'the playground did not report its second origin');

    const mocked = await fetch(`${altOrigin}/api/mocked-across`);
    assertEqual(mocked.status, 200, 'status');
    assertEqual((await mocked.json()).origin, 'mocked', 'body');

    const error = await expectRejection(
      fetch(`${altOrigin}/api/control`),
      'the unmocked cross-origin request',
    );
    assert(error instanceof TypeError, `expected a CORS TypeError, got ${String(error)}`);
    return 'mocked cross-origin succeeded; the same call unmocked was blocked';
  },
});

/* -------------------------------------------------------------------------- */
/* Passthrough fidelity                                                       */
/* -------------------------------------------------------------------------- */

add('a passthrough response keeps its own status, headers and redirects', {
  rules: [],
  doc: 'Observing a request must not change it. The traffic log reads a clone, never the response the page is holding.',
  async run() {
    const redirected = await fetch('/real/redirect');
    assertEqual(redirected.status, 200, 'status after the redirect');
    assertEqual(redirected.redirected, true, 'redirected');
    assertEqual((await redirected.json()).redirected, true, 'body');

    const error = await fetch('/real/status?code=503');
    assertEqual(error.status, 503, 'a real 503 is still a 503');
    return 'the real network was reported on, not altered';
  },
});

add('a passthrough body is still fully readable by the page', {
  rules: [],
  doc: 'The log reads its copy from a clone(), capped and never awaited on the request path, so the page keeps a complete body.',
  async run() {
    const startedAt = now();
    const response = await fetch('/real/echo-body', { method: 'POST', body: 'x'.repeat(20000) });
    const body = await response.json();
    assertEqual(body.server, true, 'reached the server');
    assertEqual(body.body.length, 20000, 'the server received the whole payload');
    return `a 20 kB payload round-tripped in ${String(Math.round(now() - startedAt))}ms`;
  },
});
