/**
 * Handlers: the response as a function of the request.
 *
 * The code runs in a sandboxed extension frame, not in this page -- and this
 * page is served with `script-src 'self'` and no `unsafe-eval`, so none of it
 * could work by compiling code here. That is the point of the architecture and
 * it is under test on every one of these.
 */
import {
  assert,
  assertAtLeast,
  assertAtMost,
  assertDeep,
  assertEqual,
  assertIncludes,
  drain,
  expectRejection,
  nonce,
  now,
  setCookie,
  suite,
  waitForXhr,
} from '../harness.js';

const add = suite(
  'handler',
  'Handlers',
  'User-written JavaScript answering a request, in a sandboxed frame.',
);

/* -------------------------------------------------------------------------- */
/* The request a handler is given                                             */
/* -------------------------------------------------------------------------- */

add('the whole request arrives, and res builds the answer', {
  rules: ['rule_h_echo'],
  async run() {
    const clear = setCookie('mode', 'staging');
    try {
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
      assertIncludes(body.host, '127.0.0.1', 'req.host');
      assertEqual(body.page, '2', 'req.query.page');
      assertDeep(body.repeated, ['a', 'b'], 'req.queryAll.tag');
      assertEqual(body.auth, 'Bearer abc', 'req.headers.authorization');
      assertEqual(body.cookie, 'staging', 'req.cookies.mode');
      assertEqual(body.sent, 'hello', 'req.body');
      assertEqual(body.transport, 'fetch', 'req.transport');
      return 'method, path, query, headers, cookies and payload all arrived';
    } finally {
      clear();
    }
  },
});

add('req.startedAt is when the page asked, not when the code ran', {
  rules: ['pg_h_startedat'],
  async run() {
    const before = Date.now();
    const body = await (await fetch('/pg/h/started-at')).json();
    assertAtLeast(body.startedAt, before - 50, 'startedAt');
    assertAtMost(body.startedAt, body.sandboxNow + 5, 'startedAt is before the sandbox ran');
    return `${String(body.sandboxNow - body.startedAt)}ms from the page asking to the handler running`;
  },
});

add('the payload is handed over as the raw string the page sent', {
  rules: ['pg_h_body_parse'],
  async run() {
    const sent = await (
      await fetch('/pg/h/body', { method: 'POST', body: JSON.stringify({ note: 'parsed' }) })
    ).json();
    assertEqual(sent.note, 'parsed', 'what the handler parsed');

    const empty = await (await fetch('/pg/h/body')).json();
    assertEqual(empty.note, null, 'no body means req.body is null');
    return 'a string, never a pre-parsed object, so the handler decides';
  },
});

add('named groups in a regex pattern arrive as req.params', {
  rules: ['rule_h_params'],
  doc: 'An Express route in everything but spelling.',
  async run() {
    const body = await (await fetch('/api/h/users/42/posts/7')).json();
    assertEqual(body.id, '42', 'req.params.id');
    assertEqual(body.postId, '7', 'req.params.postId');
    return 'the url pattern captured the route parameters';
  },
});

add('wildcard captures arrive positionally', {
  rules: ['pg_h_wild_params'],
  async run() {
    const body = await (await fetch('/pg/h/wild/middle/x/z')).json();
    assertEqual(body.zero, 'middle', "params['0']");
    assertEqual(body.one, 'z', "params['1']");
    return '* and ? captured under "0" and "1"';
  },
});

/* -------------------------------------------------------------------------- */
/* The four ways to answer                                                    */
/* -------------------------------------------------------------------------- */

add('returning a plain object is a 200 json body', {
  rules: ['rule_h_gate'],
  async run() {
    const response = await fetch('/api/users?vip=1');
    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('content-type'), 'application/json', 'content-type');
    assertEqual((await response.json()).via, 'handler', 'body.via');
    return 'the returned value became the response';
  },
});

add('a returned string is text, a returned array or number is json', {
  rules: ['pg_h_string', 'pg_h_array', 'pg_h_number'],
  async run() {
    const string = await fetch('/pg/h/string');
    assertEqual(
      string.headers.get('content-type'),
      'text/plain;charset=utf-8',
      'string content-type',
    );
    assertEqual(await string.text(), 'plain words', 'string body');

    const array = await fetch('/pg/h/array');
    assertEqual(array.headers.get('content-type'), 'application/json', 'array content-type');
    assertDeep(await array.json(), [1, 2, 3], 'array body');

    const number = await fetch('/pg/h/number');
    assertEqual(await number.text(), '42', 'number body');
    return 'the type of the returned value picked the content type';
  },
});

add('sending without returning works too', {
  rules: ['pg_h_sent_only'],
  doc: 'Both habits are valid: `return res.json(x)` and a bare `res.json(x)`.',
  async run() {
    const response = await fetch('/pg/h/sent-only');
    assertEqual(response.status, 202, 'status');
    assertEqual((await response.json()).sent, 'without a return', 'body');
    return 'what was sent on the way through became the answer';
  },
});

add('status and headers set beforehand apply to a plain return', {
  rules: ['pg_h_status_plain'],
  async run() {
    const response = await fetch('/pg/h/status-plain');
    assertEqual(response.status, 202, 'status');
    assertEqual(response.headers.get('x-plain'), 'yes', 'header');
    assertEqual((await response.json()).plain, true, 'body');
    return 'the shortest form still respects everything set before it';
  },
});

/* -------------------------------------------------------------------------- */
/* The res surface                                                            */
/* -------------------------------------------------------------------------- */

add('res.sendStatus answers with a status and nothing else', {
  rules: ['pg_h_send_status'],
  async run() {
    const response = await fetch('/pg/h/send-status');
    assertEqual(response.status, 418, 'status');
    assertEqual(response.statusText, "I'm a Teapot", 'statusText');
    assertEqual(await response.text(), '', 'body');
    return 'a status on its own';
  },
});

add('res.end sends no body and names no content type', {
  rules: ['pg_h_end'],
  async run() {
    const response = await fetch('/pg/h/end');
    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('content-type'), null, 'content-type');
    assertEqual(await response.text(), '', 'body');
    return 'empty, and honest about being empty';
  },
});

add('res.text stringifies whatever it is given', {
  rules: ['pg_h_text'],
  async run() {
    const response = await fetch('/pg/h/text');
    assertEqual(response.headers.get('content-type'), 'text/plain;charset=utf-8', 'content-type');
    assertEqual(await response.text(), '42', 'body');
    return 'a number sent as text is text';
  },
});

add('res.set takes an object of headers', {
  rules: ['pg_h_set_object'],
  async run() {
    const response = await fetch('/pg/h/set-object');
    assertEqual(response.headers.get('x-a'), '1', 'X-A');
    assertEqual(response.headers.get('x-b'), '2', 'X-B');
    return 'both forms of res.set are supported';
  },
});

add('a rule delay and res.delay add up', {
  rules: ['pg_h_delay'],
  slow: true,
  doc: 'The rule delay runs before the handler is even called, so the two compose rather than one replacing the other.',
  async run() {
    const startedAt = now();
    const response = await fetch('/pg/h/delay');
    const elapsed = now() - startedAt;
    assertEqual(response.status, 200, 'status');
    assertAtLeast(elapsed, 300, 'elapsed ms for 100 + 250');
    return `waited ${String(Math.round(elapsed))}ms`;
  },
});

add('res.fail raises a network error from code', {
  rules: ['pg_h_fail'],
  async run() {
    const error = await expectRejection(fetch('/pg/h/fail'), 'res.fail');
    assertEqual(error.name, 'AbortError', 'error.name');
    return 'a handler can decide to fail, not only to answer';
  },
});

add('res.passthrough hands the request to the real network', {
  rules: ['pg_h_passthrough'],
  async run() {
    const body = await (await fetch('/pg/h/passthrough')).json();
    assertEqual(body.server, true, 'the fixture server answered');
    return 'the handler looked, then stepped aside';
  },
});

add('res.stream delivers a body in pieces, framed by the format', {
  rules: ['rule_h_stream'],
  async run() {
    const response = await fetch('/api/h/stream');
    assertEqual(response.headers.get('content-type'), 'application/x-ndjson', 'content-type');
    const { pieces, text } = await drain(response);
    assertAtLeast(pieces.length, 3, 'reads');
    const rows = text
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assertEqual(rows.length, 3, 'records');
    assertEqual(rows[2].n, 3, 'last record');
    return `${String(pieces.length)} chunks, framed as ndjson`;
  },
});

add('res.stream defaults to sse when no format is named', {
  rules: ['pg_h_stream_default'],
  async run() {
    const response = await fetch('/pg/h/stream-default');
    assertEqual(response.headers.get('content-type'), 'text/event-stream', 'content-type');
    const { text } = await drain(response);
    assertEqual(text, 'data: {"n":1}\n\ndata: {"n":2}\n\n', 'framed body');
    return 'the default is the one an event source needs';
  },
});

add('res.stream with repeat 0 never ends either', {
  rules: ['pg_h_stream_endless'],
  async run() {
    const controller = new AbortController();
    const response = await fetch('/pg/h/stream-endless', { signal: controller.signal });
    const reader = response.body.getReader();
    for (let index = 0; index < 3; index += 1) {
      assertEqual((await reader.read()).done, false, `read ${String(index + 1)}`);
    }
    controller.abort();
    return 'the same endless behaviour, produced by code';
  },
});

/* -------------------------------------------------------------------------- */
/* Declining                                                                  */
/* -------------------------------------------------------------------------- */

add('next() hands the request to the rule below', {
  rules: ['rule_h_gate', 'rule_users404'],
  doc: 'A handler at the top of the list is middleware over everything under it, using the priority model that already exists.',
  async run() {
    const response = await fetch('/api/users');
    assertEqual(response.status, 404, 'status');
    assertEqual(response.headers.get('x-mocked'), 'yes', 'answered by the 404 rule');
    return 'declining fell through to the next matching rule';
  },
});

add('returning nothing, or null, also declines', {
  rules: ['pg_h_decline', 'pg_h_decline_target'],
  doc: 'Falling off the end of a middleware is what middleware does, so it means the same thing as calling next().',
  async run() {
    for (const mode of ['nothing', 'null', 'next']) {
      const response = await fetch(`/pg/h/decline?mode=${mode}`);
      assertEqual(response.status, 418, `mode=${mode} fell through`);
    }
    const answered = await fetch('/pg/h/decline');
    assertEqual(answered.status, 200, 'the handler answered when it wanted to');
    assertEqual((await answered.json()).answered, 'by the handler', 'body');
    return 'three ways to decline, and one to answer';
  },
});

/* -------------------------------------------------------------------------- */
/* store                                                                      */
/* -------------------------------------------------------------------------- */

add('store survives between requests, which no declarative rule can do', {
  rules: ['rule_h_store'],
  async run() {
    const run = nonce('run');
    const seen = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`/api/h/flaky?run=${run}`);
      seen.push(`${String(response.status)}:${String((await response.json()).attempt)}`);
    }
    assertEqual(seen.join(' '), '200:1 200:2 503:3', 'three calls, counted');
    return 'the third call failed, as the handler decided it would';
  },
});

add('each rule gets its own store', {
  rules: ['pg_h_store_a', 'pg_h_store_b'],
  async run() {
    const run = nonce('run');
    await fetch(`/pg/h/store-a?run=${run}`);
    const a = await (await fetch(`/pg/h/store-a?run=${run}`)).json();
    const b = await (await fetch(`/pg/h/store-b?run=${run}`)).json();
    assertEqual(a.count, 2, 'rule A counted its own calls');
    assertEqual(b.count, 1, "rule B did not see rule A's");
    return 'two counters, no crosstalk';
  },
});

/* -------------------------------------------------------------------------- */
/* The shapes of source people paste                                          */
/* -------------------------------------------------------------------------- */

add('async and await work inside a handler', {
  rules: ['pg_h_async'],
  async run() {
    const body = await (await fetch('/pg/h/async')).json();
    assertEqual(body.awaited, true, 'body');
    return 'a promise was awaited before the answer was formed';
  },
});

add('an arrow function, export default and module.exports all compile', {
  rules: ['pg_h_arrow', 'pg_h_export_default', 'pg_h_module_exports'],
  doc: 'Anyone who has written a route handler will paste one of these. Greeting them with "SyntaxError: Unexpected token export" would teach nothing.',
  async run() {
    assertEqual((await (await fetch('/pg/h/arrow')).json()).form, 'arrow', 'arrow function');
    assertEqual(
      (await (await fetch('/pg/h/export-default')).json()).form,
      'export default',
      'export default',
    );
    assertEqual(
      (await (await fetch('/pg/h/module-exports')).json()).form,
      'module.exports',
      'module.exports',
    );
    return 'three source shapes, one contract';
  },
});

add('console inside a handler reaches the page console', {
  rules: ['pg_h_console'],
  doc: 'The sandbox has its own console, in a DevTools context nobody has selected. These are forwarded to where the person debugging already is.',
  async run() {
    const seen = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args) => {
      seen.push(args.join(' '));
      originalLog.apply(console, args);
    };
    console.warn = (...args) => {
      seen.push(args.join(' '));
      originalWarn.apply(console, args);
    };
    try {
      await fetch('/pg/h/console');
      // The log messages are separate postMessages from the answer itself.
      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    assert(
      seen.some((line) => line.includes('hello from a handler')),
      `expected a forwarded log, saw ${JSON.stringify(seen)}`,
    );
    assert(
      seen.some((line) => line.includes('[decoy')),
      'forwarded lines should name the rule they came from',
    );
    return `${String(seen.length)} lines forwarded, tagged with the rule`;
  },
});

/* -------------------------------------------------------------------------- */
/* Every way a handler can go wrong                                           */
/* -------------------------------------------------------------------------- */

add('a handler that throws answers 500 and never hits the network', {
  rules: ['rule_h_throws'],
  doc: 'Not a passthrough, which is the tempting choice: a crashed handler quietly letting the request reach the real API can mutate real data and hides the bug behind a working-looking app.',
  async run() {
    const response = await fetch('/api/h/throws');
    assertEqual(response.status, 500, 'status');
    assertEqual(response.headers.get('x-decoy-error'), 'handler', 'error marker');
    assertIncludes((await response.json()).detail, 'nope', 'the ReferenceError in the body');
    return 'the crash was attributable, and the real api was left alone';
  },
});

add('throwing a bare string is reported too', {
  rules: ['pg_h_throw_string'],
  async run() {
    const response = await fetch('/pg/h/throw-string');
    assertEqual(response.status, 500, 'status');
    assertIncludes((await response.json()).detail, 'a bare string', 'detail');
    return 'not everything thrown is an Error, and the report survives that';
  },
});

add('source that will not compile is reported as a compile error', {
  rules: ['pg_h_compile_error'],
  async run() {
    const response = await fetch('/pg/h/compile-error');
    assertEqual(response.status, 500, 'status');
    const body = await response.json();
    assertIncludes(JSON.stringify(body), 'SyntaxError', 'the syntax error is named');
    return 'a broken rule fails loudly rather than passing traffic through';
  },
});

add('a handler that never answers is cut off', {
  rules: ['rule_h_hangs'],
  slow: true,
  async run() {
    const startedAt = Date.now();
    const response = await fetch('/api/h/hangs');
    const elapsed = Date.now() - startedAt;
    assertEqual(response.status, 500, 'status');
    assertIncludes(
      (await response.json()).detail.toLowerCase(),
      'did not',
      'a timeout explanation',
    );
    assert(elapsed < 3000, `took ${String(elapsed)}ms, which is not a timeout`);
    return `stopped after ${String(elapsed)}ms rather than hanging the page`;
  },
});

add('a synchronous infinite loop is cut off from outside the sandbox', {
  rules: ['pg_h_spin'],
  slow: true,
  doc: 'No timer inside the sandbox frame will ever run again, so the page times out independently and replaces the frame.',
  async run() {
    const startedAt = Date.now();
    const response = await fetch('/pg/h/spin');
    const elapsed = Date.now() - startedAt;
    assertEqual(response.status, 500, 'status');
    assert(elapsed < 3000, `took ${String(elapsed)}ms`);
    return `the wedged frame was given up on after ${String(elapsed)}ms`;
  },
});

add('the next handler still works after one has been cut off', {
  rules: ['rule_h_params'],
  doc: 'The wedged sandbox frame is replaced, or one bad handler would take every later handler down with it.',
  async run() {
    const body = await (await fetch('/api/h/users/9/posts/1')).json();
    assertEqual(body.id, '9', 'req.params.id');
    return 'the sandbox recovered and the next handler answered';
  },
});

/* -------------------------------------------------------------------------- */
/* Over XHR                                                                   */
/* -------------------------------------------------------------------------- */

add('a handler answers an asynchronous xhr', {
  rules: ['rule_h_xhr'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/h/xhr');
    xhr.send();
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'load', 'event');
    assertEqual(settled.status, 200, 'status');
    assertEqual(JSON.parse(xhr.responseText).transport, 'xhr', 'req.transport');
    return 'the handler ran for an xhr and the events fired';
  },
});

add('a handler cannot answer a synchronous xhr, and says so', {
  rules: ['pg_h_sync_xhr'],
  doc: 'The code has to run in another frame before the response exists, and send() cannot wait for that. A 500 naming the problem beats a silent passthrough.',
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/h/sync-xhr', false);
    xhr.send();
    assertEqual(xhr.status, 500, 'status');
    assertIncludes(xhr.responseText.toLowerCase(), 'synchronous', 'the explanation');
    return 'the limitation is reported rather than guessed at';
  },
});
