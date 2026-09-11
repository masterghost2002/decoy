/**
 * The XMLHttpRequest surface.
 *
 * XHR is the older and much larger contract of the two, and it is the one that
 * breaks in ways people notice: a library attaching handlers after send(), a
 * responseType that should make responseText throw, a readyState that skips a
 * step. Every one of those is here.
 */
import {
  assert,
  assertAtLeast,
  assertEqual,
  assertIncludes,
  suite,
  waitForXhr,
  xhrRequest,
} from '../harness.js';

const add = suite(
  'xhr',
  'XMLHttpRequest',
  'The full lifecycle, response types, headers and timeouts.',
);

/* -------------------------------------------------------------------------- */
/* Lifecycle                                                                  */
/* -------------------------------------------------------------------------- */

add('the readyState sequence is the real one', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    const states = [];
    xhr.addEventListener('readystatechange', () => {
      states.push(xhr.readyState);
    });
    xhr.open('GET', '/pg/plain');
    xhr.send();
    await waitForXhr(xhr);

    assertEqual(states[0], 1, 'OPENED');
    assert(states.includes(2), `expected HEADERS_RECEIVED in ${JSON.stringify(states)}`);
    assert(states.includes(3), `expected LOADING in ${JSON.stringify(states)}`);
    assertEqual(states[states.length - 1], 4, 'DONE');
    return `states ${states.join(' → ')}`;
  },
});

add('the event sequence is the real one too', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    const events = [];
    for (const type of ['loadstart', 'progress', 'load', 'loadend']) {
      xhr.addEventListener(type, () => {
        events.push(type);
      });
    }
    xhr.open('GET', '/pg/plain');
    xhr.send();
    await new Promise((resolve) => {
      xhr.addEventListener('loadend', resolve, { once: true });
    });

    assertEqual(events[0], 'loadstart', 'first event');
    assertEqual(events[events.length - 1], 'loadend', 'last event');
    assert(events.includes('progress'), `expected progress in ${JSON.stringify(events)}`);
    assert(events.indexOf('load') < events.indexOf('loadend'), 'load comes before loadend');
    return events.join(' → ');
  },
});

add('handlers attached after send() still fire', {
  rules: ['rule_users404'],
  doc: 'The pattern axios and jQuery both use. A synchronous delivery would silently never reach them.',
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/users');
    xhr.send();
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'load', 'event');
    assertEqual(xhr.status, 404, 'status');
    return 'delivery stayed asynchronous';
  },
});

add('onreadystatechange as a property works as well as addEventListener', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    const states = [];
    xhr.onreadystatechange = () => {
      states.push(xhr.readyState);
    };
    const settled = new Promise((resolve) => {
      xhr.onload = resolve;
    });
    xhr.open('GET', '/pg/plain');
    xhr.send();
    await settled;
    assertEqual(states[states.length - 1], 4, 'last state');
    return 'the property handlers fired too';
  },
});

add('a reused instance drops the mocked state', {
  rules: ['rule_users404'],
  doc: "The patch shadows properties on the instance; reopening has to restore them, or the second request reports the first one's answer.",
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
    return 'mocked, then real, on one instance';
  },
});

add('an instance can go from real to mocked as well', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/ping');
    xhr.send();
    await waitForXhr(xhr);
    assertEqual(JSON.parse(xhr.responseText).pong, true, 'the real one');

    xhr.open('GET', '/pg/plain');
    xhr.send();
    await waitForXhr(xhr);
    assertEqual(JSON.parse(xhr.responseText).plain, true, 'the mocked one');
    return 'real, then mocked, on one instance';
  },
});

/* -------------------------------------------------------------------------- */
/* Status, headers and url                                                    */
/* -------------------------------------------------------------------------- */

add('status, statusText, responseURL and headers are all synthesized', {
  rules: ['rule_users404'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/api/users');
    assertEqual(xhr.status, 404, 'status');
    assertEqual(xhr.statusText, 'Not Found', 'statusText');
    assertEqual(xhr.getResponseHeader('x-mocked'), 'yes', 'getResponseHeader');
    assertEqual(xhr.getResponseHeader('X-MOCKED'), 'yes', 'header lookup is case-insensitive');
    assertIncludes(xhr.getAllResponseHeaders(), 'x-mocked: yes', 'getAllResponseHeaders');
    assert(xhr.responseURL.endsWith('/api/users'), `responseURL was ${xhr.responseURL}`);
    assertEqual(JSON.parse(xhr.responseText).error.code, 'NOT_FOUND', 'responseText');
    return 'the full head, as the page would have received it';
  },
});

add('getAllResponseHeaders is CRLF-separated, one header per line', {
  rules: ['pg_respond_headers'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/respond/headers');
    const raw = xhr.getAllResponseHeaders();
    const lines = raw.split('\r\n').filter((line) => line.length > 0);
    assert(lines.length >= 3, `expected several lines, got ${JSON.stringify(raw)}`);
    assert(
      lines.every((line) => line.includes(': ')),
      `every line should be "name: value": ${JSON.stringify(lines)}`,
    );
    return `${String(lines.length)} headers in the platform's own format`;
  },
});

add('a missing header reads as null', {
  rules: ['pg_plain'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/plain');
    assertEqual(xhr.getResponseHeader('x-not-there'), null, 'missing header');
    return 'null, not an empty string';
  },
});

add('a request header set by the page reaches the matcher', {
  rules: ['pg_echo'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/echo', { headers: { 'X-Sent': 'by-xhr' } });
    assertEqual(
      JSON.parse(xhr.responseText).headers['x-sent'],
      'by-xhr',
      'the header the handler saw',
    );
    return 'setRequestHeader is observed, not swallowed';
  },
});

add('a 204 has no body and says so', {
  rules: ['rule_empty'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/api/empty');
    assertEqual(xhr.status, 204, 'status');
    assertEqual(xhr.statusText, 'No Content', 'statusText');
    assertEqual(xhr.responseText, '', 'responseText');
    return 'empty, and correctly empty';
  },
});

/* -------------------------------------------------------------------------- */
/* responseType                                                               */
/* -------------------------------------------------------------------------- */

add('responseType text and the default both give a string', {
  rules: ['pg_plain'],
  async run() {
    const empty = await xhrRequest('GET', '/pg/plain');
    assertEqual(typeof empty.xhr.response, 'string', 'default responseType');

    const text = await xhrRequest('GET', '/pg/plain', { responseType: 'text' });
    assertEqual(text.xhr.response, text.xhr.responseText, 'text responseType');
    return 'both spellings of the same thing';
  },
});

add('responseType json parses, and responseText then throws', {
  rules: ['rule_users404'],
  doc: 'responseText throwing for a non-text responseType is the platform behaviour. A mock that was more forgiving would hide the bug.',
  async run() {
    const { xhr } = await xhrRequest('GET', '/api/users', { responseType: 'json' });
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
});

add('responseType json on an invalid body gives null, not a throw', {
  rules: ['pg_respond_broken_json'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/respond/broken-json', { responseType: 'json' });
    assertEqual(xhr.response, null, 'response');
    return 'the platform answer for unparseable json';
  },
});

add('responseType arraybuffer gives the bytes', {
  rules: ['pg_binary'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/binary', { responseType: 'arraybuffer' });
    assert(
      xhr.response instanceof ArrayBuffer,
      `expected an ArrayBuffer, got ${String(xhr.response)}`,
    );
    const text = new TextDecoder().decode(new Uint8Array(xhr.response));
    assertEqual(text, 'not really binary, but typed as it', 'decoded body');
    return `${String(xhr.response.byteLength)} bytes`;
  },
});

add('responseType blob gives a Blob with the right type', {
  rules: ['pg_binary'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/binary', { responseType: 'blob' });
    assert(xhr.response instanceof Blob, `expected a Blob, got ${String(xhr.response)}`);
    assertEqual(xhr.response.type, 'application/octet-stream', 'blob type from the content type');
    assertIncludes(await xhr.response.text(), 'not really binary', 'blob contents');
    return 'the content type the rule set became the blob type';
  },
});

add('responseType document parses xml', {
  rules: ['pg_xml'],
  async run() {
    const { xhr } = await xhrRequest('GET', '/pg/xml', { responseType: 'document' });
    assert(xhr.response !== null, 'expected a parsed document');
    assertEqual(xhr.response.querySelector('item')?.getAttribute('id'), '1', 'parsed attribute');
    return 'a Document, not a string';
  },
});

add('responseText throws for every non-text responseType', {
  rules: ['pg_binary'],
  async run() {
    const checked = [];
    for (const type of ['arraybuffer', 'blob', 'document']) {
      const { xhr } = await xhrRequest('GET', '/pg/binary', { responseType: type });
      try {
        void xhr.responseText;
        throw new Error(`responseText should have thrown for ${type}`);
      } catch (error) {
        assertEqual(error.name, 'InvalidStateError', `error for ${type}`);
        checked.push(type);
      }
    }
    return `${checked.join(', ')} all refuse responseText`;
  },
});

/* -------------------------------------------------------------------------- */
/* Synchronous requests                                                       */
/* -------------------------------------------------------------------------- */

add('a synchronous xhr is mocked with the rules already known', {
  rules: ['pg_plain'],
  doc: 'A truly synchronous request cannot wait for anything, so it decides with whatever config has already reached the page.',
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/plain', false);
    xhr.send();
    assertEqual(xhr.status, 200, 'status');
    assertEqual(xhr.readyState, 4, 'readyState');
    assertEqual(JSON.parse(xhr.responseText).plain, true, 'body');
    return 'blocking, and answered without a round trip';
  },
});

add('a synchronous xhr still reports its headers', {
  rules: ['pg_respond_headers'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/respond/headers', false);
    xhr.send();
    assertEqual(xhr.getResponseHeader('x-one'), '1', 'header');
    return 'the same head as the asynchronous path';
  },
});

add('an unmatched synchronous xhr still reaches the network', {
  rules: [],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/ping', false);
    xhr.send();
    assertEqual(JSON.parse(xhr.responseText).pong, true, 'body');
    return 'passthrough works on the blocking path too';
  },
});

/* -------------------------------------------------------------------------- */
/* Odds and ends                                                              */
/* -------------------------------------------------------------------------- */

add('withCredentials does not stop a request being mocked', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/plain');
    xhr.withCredentials = true;
    xhr.send();
    await waitForXhr(xhr);
    assertEqual(xhr.status, 200, 'status');
    return 'a flag about a network request that never happens';
  },
});

add('a POST body is sent, matched and echoed back', {
  rules: ['pg_echo'],
  async run() {
    const { xhr } = await xhrRequest('POST', '/pg/echo?via=xhr', {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sent: true }),
    });
    const body = JSON.parse(xhr.responseText);
    assertEqual(body.method, 'POST', 'method');
    assertEqual(body.transport, 'xhr', 'transport');
    assertEqual(JSON.parse(body.body).sent, true, 'payload');
    return 'the handler saw the payload the page sent';
  },
});

add('a HEAD request is mocked over xhr too', {
  rules: ['pg_method_head'],
  async run() {
    const { xhr } = await xhrRequest('HEAD', '/pg/method/head');
    assertEqual(xhr.status, 200, 'status');
    return 'HEAD reaches the matcher like any other method';
  },
});

add('a mocked stream still reports progress lengths', {
  rules: ['rule_ndjson'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/ndjson');
    let last = null;
    xhr.addEventListener('progress', (event) => {
      last = event;
    });
    xhr.send();
    await waitForXhr(xhr);
    assert(last !== null, 'expected at least one progress event');
    assertAtLeast(last.loaded, 1, 'loaded');
    return `final progress reported ${String(last.loaded)} bytes`;
  },
});
