/**
 * Conditions: which *call* to an endpoint a rule takes, once the url and method
 * have already matched.
 *
 * Every case here is a pair. The matching request has to be intercepted and the
 * near-identical one has to reach the real server, because a condition that
 * always passed would satisfy the first half of all of them.
 */
import { assert, assertDeep, assertEqual, setCookie, suite } from '../harness.js';

const add = suite(
  'cond',
  'Conditions',
  'Header, cookie, query, body and json-path gates on a rule.',
);

/** Resolves to `true` when the rule took the call, `false` when it went real. */
async function mocked(url, init) {
  const body = await (await fetch(url, init)).json();
  return body.server !== true;
}

/** Both halves of a condition case in one line. */
function pair(name, spec) {
  add(name, {
    rules: spec.rules,
    doc: spec.doc,
    async run() {
      assert(await mocked(...spec.hit), `the matching request should have been intercepted`);
      assert(!(await mocked(...spec.miss)), `the near-miss should have reached the server`);
      return spec.detail;
    },
  });
}

/* -------------------------------------------------------------------------- */
/* header                                                                     */
/* -------------------------------------------------------------------------- */

pair('header exists', {
  rules: ['pg_cond_header_exists'],
  hit: ['/pg/cond/header/exists', { headers: { 'X-Flag': 'anything' } }],
  miss: ['/pg/cond/header/exists'],
  detail: 'presence alone was the test',
});

pair('header is missing', {
  rules: ['pg_cond_header_absent'],
  hit: ['/pg/cond/header/absent'],
  miss: ['/pg/cond/header/absent', { headers: { 'X-Flag': '1' } }],
  detail: 'absence is a condition too',
});

pair('header equals', {
  rules: ['pg_cond_header_equals'],
  hit: ['/pg/cond/header/equals', { headers: { 'X-Env': 'staging' } }],
  miss: ['/pg/cond/header/equals', { headers: { 'X-Env': 'prod' } }],
  detail: 'the value decided it',
});

pair('header does not equal', {
  rules: ['pg_cond_header_not_equals'],
  hit: ['/pg/cond/header/not-equals', { headers: { 'X-Env': 'staging' } }],
  miss: ['/pg/cond/header/not-equals', { headers: { 'X-Env': 'prod' } }],
  detail: 'notEquals took everything except prod',
});

add('a missing header cannot satisfy notEquals', {
  rules: ['pg_cond_header_not_equals'],
  doc: 'Every operator except exists/notExists needs something to compare against. An absent value is not "different from prod", it is absent.',
  async run() {
    assert(!(await mocked('/pg/cond/header/not-equals')), 'no header means no match');
    return 'absence is tested with notExists, not with notEquals';
  },
});

pair('header contains', {
  rules: ['pg_cond_header_contains'],
  hit: ['/pg/cond/header/contains', { headers: { 'X-Trace': 'xx-abc-yy' } }],
  miss: ['/pg/cond/header/contains', { headers: { 'X-Trace': 'xx-def-yy' } }],
  detail: 'substring found',
});

pair('header does not contain', {
  rules: ['pg_cond_header_not_contains'],
  hit: ['/pg/cond/header/not-contains', { headers: { 'X-Trace': 'clean' } }],
  miss: ['/pg/cond/header/not-contains', { headers: { 'X-Trace': 'has-abc' } }],
  detail: 'the negative form works the same way',
});

pair('header starts with', {
  rules: ['pg_cond_header_starts'],
  hit: ['/pg/cond/header/starts-with', { headers: { Authorization: 'Bearer abc123' } }],
  miss: ['/pg/cond/header/starts-with', { headers: { Authorization: 'Basic abc123' } }],
  detail: 'the scheme prefix decided it',
});

pair('header ends with', {
  rules: ['pg_cond_header_ends'],
  hit: ['/pg/cond/header/ends-with', { headers: { 'X-File': 'report.json' } }],
  miss: ['/pg/cond/header/ends-with', { headers: { 'X-File': 'report.csv' } }],
  detail: 'the suffix decided it',
});

pair('header matches a regex', {
  rules: ['pg_cond_header_matches'],
  hit: ['/pg/cond/header/matches', { headers: { 'X-Id': 'deadbeef' } }],
  miss: ['/pg/cond/header/matches', { headers: { 'X-Id': 'not-hex-at-all' } }],
  detail: 'the pattern decided it',
});

add('a condition regex that will not compile never matches', {
  rules: ['pg_cond_header_bad_regex'],
  async run() {
    assert(
      !(await mocked('/pg/cond/header/bad-regex', { headers: { 'X-Id': 'anything' } })),
      'an invalid pattern must not match',
    );
    return 'inert rather than greedy, same as an invalid url pattern';
  },
});

pair('header comparison is case-sensitive when asked', {
  rules: ['pg_cond_header_case'],
  hit: ['/pg/cond/header/case-sensitive', { headers: { 'X-Env': 'Staging' } }],
  miss: ['/pg/cond/header/case-sensitive', { headers: { 'X-Env': 'staging' } }],
  detail: 'the switch changed the answer',
});

/* -------------------------------------------------------------------------- */
/* query                                                                      */
/* -------------------------------------------------------------------------- */

pair('query parameter exists', {
  rules: ['pg_cond_query_exists'],
  hit: ['/pg/cond/query/exists?debug'],
  miss: ['/pg/cond/query/exists'],
  detail: 'a valueless parameter still exists',
});

pair('query parameter is greater than', {
  rules: ['pg_cond_query_gt'],
  hit: ['/pg/cond/query/greater-than?page=11'],
  miss: ['/pg/cond/query/greater-than?page=9'],
  detail: 'compared as numbers, not as strings',
});

pair('query parameter is less than', {
  rules: ['pg_cond_query_lt'],
  hit: ['/pg/cond/query/less-than?page=9'],
  miss: ['/pg/cond/query/less-than?page=11'],
  detail: '9 < 10, which string comparison would get wrong',
});

add('a non-numeric value can never satisfy a numeric comparison', {
  rules: ['pg_cond_query_gt'],
  async run() {
    assert(!(await mocked('/pg/cond/query/greater-than?page=many')), 'NaN is not greater than 10');
    return 'no throw, no match';
  },
});

pair('a repeated query key compares on the first value', {
  rules: ['pg_cond_query_repeated'],
  hit: ['/pg/cond/query/repeated-key?tag=first&tag=second'],
  miss: ['/pg/cond/query/repeated-key?tag=second&tag=first'],
  detail: 'URLSearchParams.get semantics, which is what callers expect',
});

/* -------------------------------------------------------------------------- */
/* cookie                                                                     */
/* -------------------------------------------------------------------------- */

add('a cookie value gates the rule', {
  rules: ['pg_cond_cookie_equals'],
  async run() {
    const clear = setCookie('pg_env', 'staging');
    try {
      assert(await mocked('/pg/cond/cookie/equals'), 'the staging cookie should have matched');
      setCookie('pg_env', 'prod');
      assert(!(await mocked('/pg/cond/cookie/equals')), 'prod should have reached the server');
    } finally {
      clear();
    }
    return 'flipping the cookie flipped the decision';
  },
});

add('a cookie that was never set satisfies notExists', {
  rules: ['pg_cond_cookie_absent'],
  async run() {
    assert(await mocked('/pg/cond/cookie/absent'), 'an unset cookie should match notExists');
    return 'absence again, this time from document.cookie';
  },
});

/* -------------------------------------------------------------------------- */
/* body and json path                                                         */
/* -------------------------------------------------------------------------- */

const post = (body, headers = { 'content-type': 'application/json' }) => ({
  method: 'POST',
  headers,
  body: typeof body === 'string' ? body : JSON.stringify(body),
});

pair('the raw body contains a string', {
  rules: ['pg_cond_body_contains'],
  hit: [
    '/pg/cond/body/contains',
    post('a haystack with a needle in it', { 'content-type': 'text/plain' }),
  ],
  miss: [
    '/pg/cond/body/contains',
    post('a haystack, and nothing else', { 'content-type': 'text/plain' }),
  ],
  detail: 'no parsing involved -- the body as sent',
});

pair('the raw body matches a regex', {
  rules: ['pg_cond_body_matches'],
  hit: ['/pg/cond/body/matches', post({ total: 42 })],
  miss: ['/pg/cond/body/matches', post({ total: 'free' })],
  detail: 'the pattern read the serialized payload',
});

pair('a json path equals a value', {
  rules: ['pg_cond_json_equals'],
  hit: ['/pg/cond/json/equals', post({ user: { role: 'admin' } })],
  miss: ['/pg/cond/json/equals', post({ user: { role: 'viewer' } })],
  detail: '"this POST, but only when the payload says admin"',
});

pair('a json path indexes into an array', {
  rules: ['pg_cond_json_index'],
  hit: ['/pg/cond/json/array-index', post({ items: [{ sku: 'A-1' }, { sku: 'B-2' }] })],
  miss: ['/pg/cond/json/array-index', post({ items: [{ sku: 'B-2' }, { sku: 'A-1' }] })],
  detail: 'items.0.sku walked the array by index',
});

pair('a json path compares numerically', {
  rules: ['pg_cond_json_gt'],
  hit: ['/pg/cond/json/greater-than', post({ cart: { total: 250 } })],
  miss: ['/pg/cond/json/greater-than', post({ cart: { total: 20 } })],
  detail: '250 > 100 as numbers',
});

pair('a json path exists', {
  rules: ['pg_cond_json_exists'],
  hit: ['/pg/cond/json/exists', post({ meta: { trace: 'abc' } })],
  miss: ['/pg/cond/json/exists', post({ meta: {} })],
  detail: 'a missing path reads as absent, not as empty',
});

add('an unparseable body makes every json-path condition fail', {
  rules: ['pg_cond_json_equals'],
  async run() {
    assert(
      !(await mocked(
        '/pg/cond/json/equals',
        post('{"user": {"role": "admin"', { 'content-type': 'application/json' }),
      )),
      'broken json cannot satisfy a json path',
    );
    return 'no throw, no match -- the request went to the server';
  },
});

pair('a json path landing on an object reads as its json', {
  rules: ['pg_cond_json_object'],
  hit: ['/pg/cond/json/object-serialized', post({ user: { role: 'admin' } })],
  miss: ['/pg/cond/json/object-serialized', post({ user: { name: 'ada' } })],
  detail: 'contains asked a question about the serialized subtree',
});

/* -------------------------------------------------------------------------- */
/* modes                                                                      */
/* -------------------------------------------------------------------------- */

add('all mode needs every condition to hold', {
  rules: ['pg_cond_all'],
  async run() {
    assert(
      await mocked('/pg/cond/mode/all?debug=1', { headers: { 'X-Env': 'staging' } }),
      'both signals should match',
    );
    assert(!(await mocked('/pg/cond/mode/all?debug=1')), 'the header alone is not enough');
    assert(
      !(await mocked('/pg/cond/mode/all', { headers: { 'X-Env': 'staging' } })),
      'the query alone is not enough',
    );
    return 'two conditions, both required';
  },
});

add('any mode fires when either condition holds', {
  rules: ['pg_cond_any'],
  async run() {
    assert(await mocked('/pg/cond/mode/any?debug=1'), 'the query signal alone');
    assert(
      await mocked('/pg/cond/mode/any', { headers: { 'X-Env': 'staging' } }),
      'the header signal alone',
    );
    assert(!(await mocked('/pg/cond/mode/any')), 'neither signal should reach the server');
    return 'either was enough; neither was not';
  },
});

add('a disabled condition is not evaluated at all', {
  rules: ['pg_cond_disabled_only', 'pg_cond_disabled_mixed'],
  doc: 'Conditions carry their own switch so a half-written one never silently blocks a rule. A rule whose only condition is off behaves as if it had none.',
  async run() {
    assert(await mocked('/pg/cond/disabled/only'), 'the impossible condition is switched off');
    assert(
      await mocked('/pg/cond/disabled/mixed', { headers: { 'X-Env': 'staging' } }),
      'only the enabled condition counted',
    );
    return 'switched off means not evaluated, not "evaluated and failed"';
  },
});

/* -------------------------------------------------------------------------- */
/* What the matcher can and cannot see                                        */
/* -------------------------------------------------------------------------- */

add('only headers the calling code set are visible', {
  rules: ['pg_cond_facts'],
  doc: 'Headers the browser adds itself -- Cookie, Origin, User-Agent, Referer -- are never readable from the page, so no condition can be written against them. The cookie *values* are readable separately, through document.cookie.',
  async run() {
    const clear = setCookie('pg_visible_probe', 'yes');
    try {
      const facts = await (
        await fetch('/pg/cond/facts?a=1&a=2&b=3', {
          headers: { 'X-Explicit': 'set-by-the-page' },
        })
      ).json();

      assertEqual(facts.headers['x-explicit'], 'set-by-the-page', 'an explicit header');
      for (const invisible of ['cookie', 'origin', 'user-agent', 'referer', 'host']) {
        assertEqual(facts.headers[invisible], undefined, `${invisible} should be invisible`);
      }
      assertEqual(facts.cookies.pg_visible_probe, 'yes', 'cookies arrive separately');
      assertDeep(facts.query, { a: '2', b: '3' }, 'query, last value wins');
      assertDeep(facts.queryAll.a, ['1', '2'], 'queryAll keeps both');
      return 'one explicit header in, five browser-added ones out';
    } finally {
      clear();
    }
  },
});

add('an HttpOnly cookie is invisible, because document.cookie cannot see it', {
  rules: ['pg_cond_facts'],
  async run() {
    await fetch('/real/set-cookie');
    const facts = await (await fetch('/pg/cond/facts')).json();
    assertEqual(facts.cookies.pg_visible, 'yes', 'the ordinary cookie is readable');
    assertEqual(facts.cookies.pg_httponly, undefined, 'the HttpOnly one is not');
    return 'a condition can only ask about cookies the page itself can read';
  },
});

add('every body shape the page can serialize is read for matching', {
  rules: ['pg_cond_bodyshape'],
  doc: 'Strings, URLSearchParams, FormData, ArrayBuffers and Blobs are all serialized for the matcher. A ReadableStream deliberately is not -- consuming it would break the request being observed.',
  async run() {
    const seen = async (body) =>
      (await (await fetch('/pg/cond/bodyshape', { method: 'POST', body })).json()).body;

    assertEqual(await seen('plain string'), 'plain string', 'string');
    assertEqual(await seen(new URLSearchParams({ a: '1', b: '2' })), 'a=1&b=2', 'URLSearchParams');

    const form = new FormData();
    form.append('a', '1');
    form.append('file', new File(['xx'], 'note.txt'));
    assertEqual(
      await seen(form),
      'a=1&file=[file note.txt]',
      'FormData names files rather than inlining them',
    );

    assertEqual(await seen(new TextEncoder().encode('typed array')), 'typed array', 'Uint8Array');
    assertEqual(await seen(new TextEncoder().encode('buffer').buffer), 'buffer', 'ArrayBuffer');
    assertEqual(await seen(new Blob(['blob text'])), 'blob text', 'Blob');

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });
    const streamed = await fetch('/pg/cond/bodyshape', {
      method: 'POST',
      body: stream,
      // Required by the platform for a stream body, and unrelated to Decoy.
      duplex: 'half',
    });
    assertEqual((await streamed.json()).body, null, 'a ReadableStream body is left unread');
    return 'seven shapes, six readable and one deliberately not';
  },
});

add('a Request object is cloned rather than consumed', {
  rules: ['pg_cond_bodyshape'],
  doc: 'fetch(new Request(...)) still has to be able to send its body afterwards, so the matcher reads a clone.',
  async run() {
    const request = new Request('/pg/cond/bodyshape', { method: 'POST', body: 'from a Request' });
    const body = await (await fetch(request)).json();
    assertEqual(body.body, 'from a Request', 'what the matcher saw');
    assertEqual(request.bodyUsed, false, 'the original was not consumed');
    return 'the clone tees the stream, so the caller keeps its body';
  },
});

add('an xhr send() body reaches the matcher too', {
  rules: ['pg_cond_json_equals'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/pg/cond/json/equals');
    xhr.setRequestHeader('content-type', 'application/json');
    const settled = new Promise((resolve) => xhr.addEventListener('load', resolve, { once: true }));
    xhr.send(JSON.stringify({ user: { role: 'admin' } }));
    await settled;
    assertEqual(JSON.parse(xhr.responseText).rule, 'pg_cond_json_equals', 'which rule answered');
    return 'send() is synchronous, and the body is read synchronously with it';
  },
});
