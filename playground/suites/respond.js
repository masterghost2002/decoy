/**
 * The respond action: a synthesized status, reason phrase, headers and body.
 *
 * This is the action almost every rule uses, so it gets the widest sweep: every
 * status class, the three statuses that forbid a body, all three body types,
 * header edge cases, and the two bodies that are deliberately not well-formed.
 */
import {
  assert,
  assertAtLeast,
  assertEqual,
  assertIncludes,
  drain,
  expectRejection,
  now,
  suite,
} from '../harness.js';

const add = suite('respond', 'Respond', 'A status, headers and a body, synthesized in the page.');

/* -------------------------------------------------------------------------- */
/* Statuses                                                                   */
/* -------------------------------------------------------------------------- */

const WITH_BODY = [200, 201, 202, 206, 400, 401, 403, 404, 409, 418, 422, 429, 500, 502, 503, 504];

add('every status class is synthesized, with its conventional reason phrase', {
  rules: WITH_BODY.map((status) => `pg_status_${String(status)}`),
  doc: 'One rule per status. The reason phrase comes from the status when the rule leaves it blank.',
  async run() {
    const phrases = {
      200: 'OK',
      404: 'Not Found',
      418: "I'm a Teapot",
      503: 'Service Unavailable',
    };
    for (const status of WITH_BODY) {
      const response = await fetch(`/pg/respond/status/${String(status)}`);
      assertEqual(response.status, status, `status ${String(status)}`);
      assertEqual(response.ok, status < 400, `ok for ${String(status)}`);
      if (phrases[status] !== undefined) {
        assertEqual(response.statusText, phrases[status], `statusText for ${String(status)}`);
      }
      assertEqual((await response.json()).status, status, `body for ${String(status)}`);
    }
    return `${String(WITH_BODY.length)} statuses, each with its own body`;
  },
});

add('204 drops the body instead of throwing', {
  rules: ['pg_status_204'],
  doc: 'The Fetch spec refuses to construct a Response with a body on 204, so the body is dropped rather than the mock failing.',
  async run() {
    const response = await fetch('/pg/respond/status/204');
    assertEqual(response.status, 204, 'status');
    assertEqual(await response.text(), '', 'body');
    assertEqual(response.body, null, 'response.body');
    return '204 constructed with no body';
  },
});

add('304 drops the body too', {
  rules: ['pg_status_304'],
  async run() {
    const response = await fetch('/pg/respond/status/304');
    assertEqual(response.status, 304, 'status');
    assertEqual(await response.text(), '', 'body');
    return '304 behaves like 204';
  },
});

add('a mocked 3xx is handed over, not followed', {
  rules: ['pg_status_301'],
  doc: 'A synthesized redirect never reaches the network stack, so nothing follows it. The caller sees the 301 and its Location header.',
  async run() {
    const response = await fetch('/pg/respond/status/301');
    assertEqual(response.status, 301, 'status');
    assertEqual(response.redirected, false, 'redirected');
    assertEqual(response.headers.get('location'), '/pg/respond/status/200', 'location');
    return 'the 301 was returned as-is';
  },
});

add('an explicit reason phrase overrides the conventional one', {
  rules: ['pg_respond_reason'],
  async run() {
    const response = await fetch('/pg/respond/reason');
    assertEqual(response.status, 299, 'status');
    assertEqual(response.statusText, 'Totally Fine', 'statusText');
    return 'statusText came from the rule';
  },
});

/* -------------------------------------------------------------------------- */
/* Headers                                                                    */
/* -------------------------------------------------------------------------- */

add('headers are synthesized, repeats are joined, blank names are dropped', {
  rules: ['pg_respond_headers'],
  doc: 'Headers keep their order and duplicates survive the wire; the Headers object joins repeats with ", " the way the platform does.',
  async run() {
    const response = await fetch('/pg/respond/headers');
    assertEqual(response.headers.get('x-one'), '1', 'x-one');
    assertEqual(response.headers.get('X-TWO'), '2', 'x-two, looked up in a different case');
    assertEqual(response.headers.get('x-repeat'), 'a, b', 'repeated header');
    const names = [...response.headers.keys()];
    assert(
      names.every((name) => name.trim().length > 0),
      `a header with a blank name should never have been sent: ${JSON.stringify(names)}`,
    );
    return 'lookup is case-insensitive and repeats join';
  },
});

add('a json body gets application/json unless the rule says otherwise', {
  rules: ['pg_status_200', 'pg_respond_ct_override'],
  async run() {
    const byDefault = await fetch('/pg/respond/status/200');
    assertEqual(byDefault.headers.get('content-type'), 'application/json', 'default content-type');

    const overridden = await fetch('/pg/respond/content-type');
    assertEqual(
      overridden.headers.get('content-type'),
      'application/vnd.api+json',
      'overridden content-type',
    );
    return 'the explicit header won';
  },
});

/* -------------------------------------------------------------------------- */
/* Bodies                                                                     */
/* -------------------------------------------------------------------------- */

add('a text body is text/plain, not json', {
  rules: ['pg_respond_text'],
  async run() {
    const response = await fetch('/pg/respond/text');
    assertEqual(response.headers.get('content-type'), 'text/plain;charset=utf-8', 'content-type');
    assertEqual(await response.text(), 'plain, and not json', 'body');
    return 'body type text carried its own content type';
  },
});

add('an empty body carries no content type at all', {
  rules: ['pg_respond_empty'],
  doc: 'Not the same as an empty string: there is no body, so there is nothing to describe.',
  async run() {
    const response = await fetch('/pg/respond/empty');
    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('content-type'), null, 'content-type');
    assertEqual(await response.text(), '', 'body');
    return 'no body and no content type';
  },
});

add('deliberately invalid json is delivered verbatim', {
  rules: ['pg_respond_broken_json'],
  doc: 'Bodies are stored as raw strings and never reformatted, because a malformed payload is a legitimate thing to mock -- it is the client error path you are trying to reach.',
  async run() {
    const response = await fetch('/pg/respond/broken-json');
    const text = await response.clone().text();
    assertEqual(text, '{"items":[1,2,', 'raw text');
    const error = await expectRejection(response.json(), 'parsing the broken body');
    assert(error instanceof SyntaxError, `expected a SyntaxError, got ${String(error)}`);
    return 'text() gives it back exactly; json() rejects, as it should';
  },
});

add('unicode survives the round trip', {
  rules: ['pg_respond_unicode'],
  async run() {
    const body = await (await fetch('/pg/respond/unicode')).json();
    assertEqual(body.emoji, '🪤', 'emoji');
    assertEqual(body.cjk, '偽装', 'cjk');
    assertEqual(body.combining, 'é', 'combining mark');
    assertEqual(body.rtl, 'مرحبا', 'right-to-left');
    return 'four scripts, byte for byte';
  },
});

add('a top-level array is a valid body', {
  rules: ['pg_respond_array'],
  async run() {
    const body = await (await fetch('/pg/respond/array')).json();
    assert(Array.isArray(body), `expected an array, got ${typeof body}`);
    assertEqual(body.length, 3, 'length');
    return 'arrays are bodies too';
  },
});

add('html can be mocked as well as json', {
  rules: ['pg_respond_html'],
  async run() {
    const response = await fetch('/pg/respond/html');
    assertEqual(response.headers.get('content-type'), 'text/html;charset=utf-8', 'content-type');
    assertIncludes(await response.text(), '<title>mocked</title>', 'body');
    return 'a document, not a payload';
  },
});

add('a 48 kB body arrives intact, and as a readable stream', {
  rules: ['pg_respond_big'],
  async run() {
    const response = await fetch('/pg/respond/big');
    const { text } = await drain(response);
    assertAtLeast(text.length, 40 * 1024, 'body length');
    const parsed = JSON.parse(text);
    assertAtLeast(parsed.items.length, 100, 'items');
    assertEqual(parsed.items[0].sku, 'SKU-00000', 'first item');
    return `${String(Math.round(text.length / 1024))} kB parsed back`;
  },
});

/* -------------------------------------------------------------------------- */
/* Delay                                                                      */
/* -------------------------------------------------------------------------- */

add('a delay is honoured before the response arrives', {
  rules: ['pg_respond_delay'],
  slow: true,
  async run() {
    const startedAt = now();
    const response = await fetch('/pg/respond/delay');
    const elapsed = now() - startedAt;
    assertEqual(response.status, 200, 'status');
    assertAtLeast(elapsed, 350, 'elapsed ms');
    return `waited ${String(Math.round(elapsed))}ms for a 400ms delay`;
  },
});

add('Set-Cookie on a mocked response is dropped by the platform', {
  rules: ['pg_respond_setcookie'],
  doc: 'A forbidden response header: the Headers guard strips it, and it would not have set a cookie anyway. Worth asserting so nobody debugs it as a bug.',
  async run() {
    const before = document.cookie.includes('pg_mocked=');
    const response = await fetch('/pg/respond/set-cookie');
    assertEqual(response.status, 200, 'status');
    assertEqual(response.headers.get('set-cookie'), null, 'set-cookie is not readable');
    assertEqual(document.cookie.includes('pg_mocked='), before, 'no cookie was set');
    return 'the header never made it out of the Headers object';
  },
});
