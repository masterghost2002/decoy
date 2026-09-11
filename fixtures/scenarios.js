/**
 * Behavioural checks for the Decoy interceptor, run inside a real page.
 *
 * Each scenario asserts against the rule set seeded by `scripts/e2e.mjs`. The
 * same file backs the manual page (buttons) and the automated run
 * (`window.__decoy.runAll()`), so there is only ever one definition of
 * "working".
 */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/** Resolves with the first of these events to fire, plus a snapshot of the xhr. */
function waitForXhr(xhr, events = ['load', 'error', 'timeout', 'abort']) {
  return new Promise((resolve) => {
    for (const type of events) {
      xhr.addEventListener(
        type,
        () => {
          resolve({ event: type, status: xhr.status, readyState: xhr.readyState });
        },
        { once: true },
      );
    }
  });
}

async function expectRejection(promise, label) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error(`${label}: expected a rejection, but it resolved`);
}

const SCENARIOS = [
  {
    name: 'fetch: mocked 404 with body and header',
    async run() {
      const response = await fetch('/api/users');
      assertEqual(response.status, 404, 'status');
      assertEqual(response.statusText, 'Not Found', 'statusText');
      assertEqual(response.headers.get('x-mocked'), 'yes', 'x-mocked header');
      assertEqual(response.headers.get('content-type'), 'application/json', 'content-type');
      assert(response.url.endsWith('/api/users'), `response.url was ${response.url}`);
      const body = await response.json();
      assertEqual(body.error.code, 'NOT_FOUND', 'body.error.code');
      return 'status, headers, body and url all synthesized';
    },
  },
  {
    name: 'fetch: passthrough rule above a broad mock wins',
    async run() {
      const response = await fetch('/api/users/me');
      assertEqual(response.status, 200, 'status');
      const body = await response.json();
      assertEqual(body.real, true, 'body.real');
      return 'narrow passthrough shadowed the broader 404 rule';
    },
  },
  {
    name: 'fetch: delay is honoured',
    async run() {
      const startedAt = performance.now();
      const response = await fetch('/api/slow');
      const elapsed = performance.now() - startedAt;
      assertEqual(response.status, 200, 'status');
      assert(elapsed >= 1400, `only waited ${Math.round(elapsed)}ms`);
      return `waited ${Math.round(elapsed)}ms`;
    },
  },
  {
    name: 'fetch: network error rejects like the platform',
    async run() {
      const error = await expectRejection(fetch('/api/boom'), 'boom');
      assert(error instanceof TypeError, `expected TypeError, got ${error.constructor.name}`);
      assertEqual(error.message, 'Failed to fetch', 'message');
      return 'TypeError: Failed to fetch';
    },
  },
  {
    name: 'fetch: abort interrupts a delayed mock',
    async run() {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 100);
      const error = await expectRejection(
        fetch('/api/slow', { signal: controller.signal }),
        'aborted slow mock',
      );
      assertEqual(error.name, 'AbortError', 'error.name');
      return 'AbortError raised mid-delay';
    },
  },
  {
    name: 'fetch: a hung request still answers to abort',
    async run() {
      const controller = new AbortController();
      setTimeout(() => {
        controller.abort();
      }, 150);
      const error = await expectRejection(
        fetch('/api/hang', { signal: controller.signal }),
        'aborted hang',
      );
      assertEqual(error.name, 'AbortError', 'error.name');
      return 'hang broken by abort rather than leaking forever';
    },
  },
  {
    name: 'fetch: 204 drops the body instead of throwing',
    async run() {
      const response = await fetch('/api/empty');
      assertEqual(response.status, 204, 'status');
      assertEqual(await response.text(), '', 'body');
      return '204 constructed with no body';
    },
  },
  {
    name: 'xhr: mocked 404 exposes status, headers and text',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/users');
      xhr.send();
      const result = await waitForXhr(xhr);
      assertEqual(result.event, 'load', 'event');
      assertEqual(xhr.status, 404, 'status');
      assertEqual(xhr.statusText, 'Not Found', 'statusText');
      assertEqual(xhr.getResponseHeader('x-mocked'), 'yes', 'getResponseHeader');
      assert(
        xhr.getAllResponseHeaders().includes('x-mocked: yes'),
        `getAllResponseHeaders was ${JSON.stringify(xhr.getAllResponseHeaders())}`,
      );
      assertEqual(JSON.parse(xhr.responseText).error.code, 'NOT_FOUND', 'responseText');
      assert(xhr.responseURL.endsWith('/api/users'), `responseURL was ${xhr.responseURL}`);
      return 'full readyState lifecycle delivered';
    },
  },
  {
    name: 'xhr: handlers attached after send() still fire',
    async run() {
      // The pattern axios and jQuery both use. A synchronous mock delivery
      // would silently never reach these handlers.
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/users');
      xhr.send();
      const result = await waitForXhr(xhr);
      assertEqual(result.event, 'load', 'event');
      assertEqual(xhr.status, 404, 'status');
      return 'delivery stayed asynchronous';
    },
  },
  {
    name: 'xhr: responseType json parses, and responseText throws',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/users');
      xhr.responseType = 'json';
      xhr.send();
      await waitForXhr(xhr);
      assertEqual(xhr.response.error.code, 'NOT_FOUND', 'parsed response');
      let threw = false;
      try {
        void xhr.responseText;
      } catch (error) {
        threw = true;
        assertEqual(error.name, 'InvalidStateError', 'error.name');
      }
      assert(threw, 'responseText should throw for responseType json');
      return 'spec-faithful for a non-text responseType';
    },
  },
  {
    name: 'xhr: timeout fires when the mock is slower than the client allows',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/slow');
      xhr.timeout = 300;
      xhr.send();
      const result = await waitForXhr(xhr);
      assertEqual(result.event, 'timeout', 'event');
      assertEqual(xhr.status, 0, 'status');
      return 'client timeout beat the 1500ms mock';
    },
  },
  {
    name: 'xhr: abort during a delayed mock',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/slow');
      xhr.send();
      setTimeout(() => {
        xhr.abort();
      }, 100);
      const result = await waitForXhr(xhr);
      assertEqual(result.event, 'abort', 'event');
      return 'abort event dispatched';
    },
  },
  {
    name: 'xhr: network error surfaces as status 0',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/boom');
      xhr.send();
      const result = await waitForXhr(xhr);
      assertEqual(result.event, 'error', 'event');
      assertEqual(xhr.status, 0, 'status');
      return 'error event dispatched';
    },
  },
  {
    name: 'xhr: unmatched request reaches the real server',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/ping');
      xhr.send();
      await waitForXhr(xhr);
      assertEqual(xhr.status, 200, 'status');
      assertEqual(JSON.parse(xhr.responseText).pong, true, 'body.pong');
      return 'passthrough left the response untouched';
    },
  },
  {
    name: 'xhr: a reused instance drops the mocked state',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/users');
      xhr.send();
      await waitForXhr(xhr);
      assertEqual(xhr.status, 404, 'first status');

      xhr.open('GET', '/api/ping');
      xhr.send();
      await waitForXhr(xhr);
      assertEqual(xhr.status, 200, 'second status');
      assertEqual(JSON.parse(xhr.responseText).pong, true, 'second body');
      return 'shadowed properties were restored on reopen';
    },
  },

  /* ---------------------------------------------------------------------- */
  /* Conditions                                                             */
  /* ---------------------------------------------------------------------- */

  {
    name: 'conditions: a json payload gate takes only the matching call',
    async run() {
      const admin = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: { role: 'admin' } }),
      });
      assertEqual(admin.status, 403, 'admin status');
      assertEqual((await admin.json()).error, 'admin', 'admin body');

      // Same url, same method, different payload: the rule must not fire.
      const viewer = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ user: { role: 'viewer' } }),
      });
      assertEqual(viewer.status, 200, 'viewer status');
      assertEqual((await viewer.json()).server, true, 'viewer reached the real server');
      return 'user.role=admin intercepted, viewer passed through';
    },
  },
  {
    name: 'conditions: a header gate distinguishes two identical urls',
    async run() {
      const authed = await fetch('/api/secure', { headers: { Authorization: 'Bearer abc123' } });
      assertEqual(authed.status, 200, 'authed status');
      assertEqual((await authed.json()).scope, 'full', 'authed body');

      const anonymous = await fetch('/api/secure');
      assertEqual((await anonymous.json()).server, true, 'anonymous reached the real server');
      return 'Authorization header decided it';
    },
  },
  {
    name: 'conditions: a cookie gate reads document.cookie',
    async run() {
      document.cookie = 'mode=staging;path=/';
      const staging = await fetch('/api/flag');
      assertEqual((await staging.json()).flag, 'staging', 'staging body');

      document.cookie = 'mode=prod;path=/';
      const prod = await fetch('/api/flag');
      assertEqual((await prod.json()).server, true, 'prod reached the real server');
      return 'cookie value flipped the decision';
    },
  },
  {
    name: 'conditions: any-mode fires when either signal is present',
    async run() {
      const viaQuery = await fetch('/api/either?debug=1');
      assertEqual((await viaQuery.json()).via, 'any', 'query signal');

      const viaHeader = await fetch('/api/either', { headers: { 'X-Debug': '1' } });
      assertEqual((await viaHeader.json()).via, 'any', 'header signal');

      const neither = await fetch('/api/either');
      assertEqual((await neither.json()).server, true, 'neither signal reached the server');
      return 'either query or header was enough; neither was not';
    },
  },
  {
    name: 'conditions: an xhr payload is read too',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/profile');
      xhr.setRequestHeader('content-type', 'application/json');
      xhr.send(JSON.stringify({ user: { role: 'admin' } }));
      await waitForXhr(xhr);
      assertEqual(xhr.status, 403, 'status');
      return 'send() body reached the matcher';
    },
  },
  {
    name: 'stream: a fetch body arrives in pieces, not all at once',
    async run() {
      const response = await fetch('/api/events');
      assertEqual(response.status, 200, 'status');
      assertEqual(response.headers.get('content-type'), 'text/event-stream', 'content-type');
      assert(response.body !== null, 'response.body should be a ReadableStream');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const pieces = [];
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        pieces.push(decoder.decode(value));
      }

      // More than one read is the whole claim: a single blob would be
      // indistinguishable from an ordinary respond rule.
      assert(pieces.length >= 2, `expected several chunks, got ${pieces.length}`);
      assertEqual(
        pieces.join(''),
        'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n',
        'framed body',
      );
      return `${pieces.length} sse events read one at a time`;
    },
  },
  {
    name: 'stream: ndjson compacts each record and repeats the list',
    async run() {
      const response = await fetch('/api/ndjson');
      assertEqual(response.headers.get('content-type'), 'application/x-ndjson', 'content-type');
      assertEqual(await response.text(), '{"a":1}\n{"b":2}\n{"a":1}\n{"b":2}\n', 'body');
      return 'pretty-printed json arrived as two one-line records, twice';
    },
  },
  {
    name: 'stream: an endless stream stays open until it is aborted',
    async run() {
      const controller = new AbortController();
      const response = await fetch('/api/forever', { signal: controller.signal });
      const reader = response.body.getReader();

      // Three reads out of a one-chunk list. A stream that stopped at the end
      // of its chunks would have reported `done` on the second.
      for (let index = 0; index < 3; index += 1) {
        const next = await reader.read();
        assertEqual(next.done, false, `read ${index + 1} done`);
      }

      // Synchronously, so no already-enqueued chunk can satisfy the read below
      // before the abort reaches it.
      controller.abort();
      const error = await expectRejection(reader.read(), 'aborted stream');
      assertEqual(error.name, 'AbortError', 'error.name');
      return 'the body never closed on its own; abort ended it';
    },
  },
  {
    name: 'xhr: a streamed response grows responseText as it arrives',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/events');

      let loadingTicks = 0;
      let sawPartial = false;
      xhr.addEventListener('readystatechange', () => {
        if (xhr.readyState !== 3) return;
        loadingTicks += 1;
        // Readable before the transfer is done is the point of the exercise.
        if (xhr.responseText.length > 0 && !xhr.responseText.includes('[DONE]')) {
          sawPartial = true;
        }
      });
      xhr.send();

      const result = await waitForXhr(xhr);
      assertEqual(result.event, 'load', 'event');
      assertEqual(xhr.status, 200, 'status');
      assert(loadingTicks >= 2, `expected several LOADING ticks, got ${loadingTicks}`);
      assert(sawPartial, 'responseText should be readable before the stream finishes');
      assertEqual(
        xhr.responseText,
        'data: {"n":1}\n\ndata: {"n":2}\n\ndata: [DONE]\n\n',
        'responseText',
      );
      return `chunks surfaced across ${loadingTicks} progress ticks`;
    },
  },
  /* ------------------------------------------------------------------ */
  /* Handlers: the response is a function of the request                  */
  /*                                                                      */
  /* This page is served with `script-src 'self'` and no `unsafe-eval`,   */
  /* so none of this could work by compiling code in the page. It runs in */
  /* a sandboxed extension frame, which the page's policy does not reach. */
  /* ------------------------------------------------------------------ */
  {
    name: 'handler: reads the whole request and answers with res',
    async run() {
      document.cookie = 'mode=staging; path=/';
      const response = await fetch('/api/h/echo?page=2&tag=a&tag=b', {
        method: 'POST',
        headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'hello' }),
      });

      assertEqual(response.status, 201, 'status from res.status()');
      assertEqual(response.headers.get('x-from'), 'handler', 'header from res.set()');
      const body = await response.json();
      assertEqual(body.method, 'POST', 'req.method');
      assertEqual(body.path, '/api/h/echo', 'req.path');
      assert(body.host.includes('127.0.0.1'), `req.host was ${body.host}`);
      assertEqual(body.page, '2', 'req.query.page');
      assertEqual(JSON.stringify(body.repeated), '["a","b"]', 'req.queryAll.tag');
      assertEqual(body.auth, 'Bearer abc', 'req.headers.authorization');
      assertEqual(body.cookie, 'staging', 'req.cookies.mode');
      assertEqual(body.sent, 'hello', 'req.body');
      assertEqual(body.transport, 'fetch', 'req.transport');
      return 'method, path, query, headers, cookies and payload all arrived';
    },
  },
  {
    name: 'handler: returning a plain object is a 200 json body',
    async run() {
      const response = await fetch('/api/users?vip=1');
      assertEqual(response.status, 200, 'status');
      assertEqual(response.headers.get('content-type'), 'application/json', 'content-type');
      const body = await response.json();
      assertEqual(body.via, 'handler', 'body.via');
      return 'the returned value became the response';
    },
  },
  {
    name: 'handler: next() hands the request to the rule below it',
    async run() {
      // Same url, no vip flag: the handler declines and the 404 rule answers.
      const response = await fetch('/api/users');
      assertEqual(response.status, 404, 'status');
      assertEqual(response.headers.get('x-mocked'), 'yes', 'answered by the 404 rule');
      return 'declining fell through to the next matching rule';
    },
  },
  {
    name: 'handler: store survives between requests',
    async run() {
      const seen = [];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const response = await fetch('/api/h/flaky');
        seen.push(`${String(response.status)}:${String((await response.json()).attempt)}`);
      }
      assertEqual(seen.join(' '), '200:1 200:2 503:3', 'three calls, counted');
      return 'the third call failed, as the handler decided it would';
    },
  },
  {
    name: 'handler: named groups in the pattern arrive as req.params',
    async run() {
      const body = await (await fetch('/api/h/users/42/posts/7')).json();
      assertEqual(body.id, '42', 'req.params.id');
      assertEqual(body.postId, '7', 'req.params.postId');
      return 'the url pattern captured the route parameters';
    },
  },
  {
    name: 'handler: res.stream() delivers a body in pieces',
    async run() {
      const response = await fetch('/api/h/stream');
      assertEqual(
        response.headers.get('content-type'),
        'application/x-ndjson',
        'content-type from the format',
      );

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      let reads = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        reads += 1;
        text += decoder.decode(value, { stream: true });
      }

      assert(reads >= 3, `expected at least 3 reads, got ${String(reads)}`);
      const rows = text.trim().split('\n').map((line) => JSON.parse(line));
      assertEqual(rows.length, 3, 'records');
      assertEqual(rows[2].n, 3, 'last record');
      return `${String(reads)} chunks, framed as ndjson by the format`;
    },
  },
  {
    name: 'handler: a handler that throws answers 500 and never hits the network',
    async run() {
      const response = await fetch('/api/h/throws');
      assertEqual(response.status, 500, 'status');
      assertEqual(response.headers.get('x-decoy-error'), 'handler', 'error marker');
      const body = await response.json();
      assert(
        body.detail.includes('nope'),
        `expected the ReferenceError in the body, got ${JSON.stringify(body)}`,
      );
      return 'the crash was attributable, and the real api was left alone';
    },
  },
  {
    name: 'handler: a handler that never answers is cut off',
    async run() {
      const startedAt = Date.now();
      const response = await fetch('/api/h/hangs');
      const elapsed = Date.now() - startedAt;
      assertEqual(response.status, 500, 'status');
      const body = await response.json();
      assert(
        body.detail.toLowerCase().includes('did not'),
        `expected a timeout explanation, got ${JSON.stringify(body)}`,
      );
      assert(elapsed < 3000, `took ${String(elapsed)}ms, which is not a timeout`);
      return `stopped after ${String(elapsed)}ms rather than hanging the page`;
    },
  },
  {
    name: 'handler: still works after one has been cut off',
    async run() {
      // The wedged sandbox frame is replaced, or one bad handler would take
      // every later handler down with it.
      const body = await (await fetch('/api/h/users/9/posts/1')).json();
      assertEqual(body.id, '9', 'req.params.id');
      return 'the sandbox recovered and the next handler answered';
    },
  },
  {
    name: 'handler: answers an xhr too',
    async run() {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', '/api/h/xhr');
      xhr.send();
      const settled = await waitForXhr(xhr);
      assertEqual(settled.event, 'load', 'event');
      assertEqual(settled.status, 200, 'status');
      const body = JSON.parse(xhr.responseText);
      assertEqual(body.transport, 'xhr', 'req.transport');
      return 'the handler ran for an asynchronous xhr and the events fired';
    },
  },
  {
    name: 'url: a full url with a domain matches in an anchored mode',
    async run() {
      // The rule is written `127.0.0.1:PORT/api/whoami` in startsWith mode --
      // exactly what the traffic panel displays, scheme and all omitted.
      const response = await fetch('/api/whoami');
      assertEqual(response.status, 200, 'status');
      assertEqual((await response.json()).who, 'mocked', 'body');

      const absolute = await fetch(`${location.origin}/api/whoami`);
      assertEqual((await absolute.json()).who, 'mocked', 'absolute body');
      return 'host-qualified pattern matched relative and absolute calls alike';
    },
  },
];

async function runAll() {
  const results = [];
  for (const scenario of SCENARIOS) {
    const startedAt = performance.now();
    try {
      const detail = await scenario.run();
      results.push({
        name: scenario.name,
        ok: true,
        detail,
        ms: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      results.push({
        name: scenario.name,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - startedAt),
      });
    }
  }
  return results;
}

window.__decoy = { runAll, scenarios: SCENARIOS.map((item) => item.name) };

/* ---------------------------------------------------------------------- */
/* Manual harness                                                        */
/* ---------------------------------------------------------------------- */

const output = document.getElementById('output');
const runButton = document.getElementById('run');

function render(results) {
  output.textContent = '';
  for (const result of results) {
    const row = document.createElement('div');
    row.className = `row ${result.ok ? 'pass' : 'fail'}`;
    row.textContent = `${result.ok ? 'PASS' : 'FAIL'}  ${result.name}  (${result.ms}ms)\n      ${result.detail}`;
    output.append(row);
  }
  const failed = results.filter((result) => !result.ok).length;
  const summary = document.createElement('div');
  summary.className = `row ${failed === 0 ? 'pass' : 'fail'}`;
  summary.textContent = `${results.length - failed}/${results.length} passed`;
  output.append(summary);
}

runButton.addEventListener('click', () => {
  runButton.disabled = true;
  output.textContent = 'Running…';
  void runAll()
    .then(render)
    .finally(() => {
      runButton.disabled = false;
    });
});
