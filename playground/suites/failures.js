/**
 * The three ways a request can fail, on both transports.
 *
 * These are the cases that are hardest to reproduce against a real API and the
 * main reason to reach for a tool like this, so each one asserts the exact
 * shape the platform would have produced -- not merely "it rejected".
 */
import {
  assert,
  assertAtLeast,
  assertEqual,
  expectRejection,
  now,
  suite,
  waitForXhr,
} from '../harness.js';

const add = suite(
  'fail',
  'Failures',
  'Network errors, timeouts and aborts, as the platform raises them.',
);

add('a failed request rejects with the platform TypeError', {
  rules: ['pg_fail_failed'],
  doc: 'The same rejection a dns failure or a CORS block produces, which is what application error paths are written against.',
  async run() {
    const error = await expectRejection(fetch('/pg/fail/failed'), 'failed');
    assert(error instanceof TypeError, `expected TypeError, got ${error.constructor.name}`);
    assertEqual(error.message, 'Failed to fetch', 'message');
    return 'TypeError: Failed to fetch';
  },
});

add('an aborted failure rejects with an AbortError', {
  rules: ['pg_fail_aborted'],
  async run() {
    const error = await expectRejection(fetch('/pg/fail/aborted'), 'aborted');
    assertEqual(error.name, 'AbortError', 'error.name');
    return 'AbortError, without anyone calling abort()';
  },
});

add('a timeout failure never settles, and answers to abort', {
  rules: ['rule_hang'],
  doc: "Nothing resolves and nothing rejects: the point is to make the caller's own timeout logic run. The only way out is the caller giving up.",
  async run() {
    const controller = new AbortController();
    let settled = false;
    const pending = fetch('/api/hang', { signal: controller.signal }).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 150));
    assert(!settled, 'the hung request should still be pending');

    controller.abort();
    await pending;
    return 'pending for 150ms, then broken by abort rather than leaking forever';
  },
});

add('a delayed failure waits before it fails', {
  rules: ['pg_fail_delayed'],
  slow: true,
  async run() {
    const startedAt = now();
    const error = await expectRejection(fetch('/pg/fail/delayed'), 'delayed failure');
    const elapsed = now() - startedAt;
    assert(error instanceof TypeError, `expected TypeError, got ${String(error)}`);
    assertAtLeast(elapsed, 250, 'elapsed ms');
    return `failed after ${String(Math.round(elapsed))}ms`;
  },
});

add('abort interrupts a delayed mock before it answers', {
  rules: ['rule_slow'],
  slow: true,
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
});

add('an already-aborted signal fails the request immediately', {
  rules: ['pg_plain'],
  async run() {
    const controller = new AbortController();
    controller.abort();
    const startedAt = now();
    const error = await expectRejection(
      fetch('/pg/plain', { signal: controller.signal }),
      'pre-aborted',
    );
    assertEqual(error.name, 'AbortError', 'error.name');
    assert(now() - startedAt < 100, 'it should not have waited');
    return 'rejected without the mock being built at all';
  },
});

add("the abort reason is the caller's, not an invented one", {
  rules: ['rule_slow'],
  doc: 'abort(reason) is how applications attach their own cancellation context. Replacing it with a generic AbortError would lose that.',
  async run() {
    const controller = new AbortController();
    const reason = new Error('a reason of my own');
    setTimeout(() => {
      controller.abort(reason);
    }, 80);
    const error = await expectRejection(
      fetch('/api/slow', { signal: controller.signal }),
      'custom reason',
    );
    assertEqual(error, reason, 'the rejection value');
    return 'the exact object passed to abort() came back';
  },
});

add('AbortSignal.timeout works against a delayed mock', {
  rules: ['pg_slow_1200'],
  slow: true,
  async run() {
    const error = await expectRejection(
      fetch('/pg/slow-1200', { signal: AbortSignal.timeout(200) }),
      'signal timeout',
    );
    assertEqual(error.name, 'TimeoutError', 'error.name');
    return 'the platform helper behaves exactly as it would on a real request';
  },
});

/* -------------------------------------------------------------------------- */
/* Over XHR                                                                   */
/* -------------------------------------------------------------------------- */

add('an xhr network error is an error event with status 0', {
  rules: ['rule_boom'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/boom');
    xhr.send();
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'error', 'event');
    assertEqual(xhr.status, 0, 'status');
    assertEqual(xhr.readyState, 4, 'readyState');
    return 'the shape a real failure has';
  },
});

add('an xhr timeout fires when the mock is slower than the client allows', {
  rules: ['pg_slow_1200'],
  slow: true,
  doc: 'A mocked xhr never reaches the network, so its native timeout would never fire. Decoy emulates it.',
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/slow-1200');
    xhr.timeout = 300;
    xhr.send();
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'timeout', 'event');
    assertEqual(xhr.status, 0, 'status');
    return 'a 300ms client timeout beat a 1200ms mock';
  },
});

add('timeout 0 means no timeout, even against a slow mock', {
  rules: ['pg_slow_300'],
  slow: true,
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/slow-300');
    xhr.timeout = 0;
    xhr.send();
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'load', 'event');
    return 'the default was not turned into a timeout';
  },
});

add('aborting an xhr during a delay raises abort, not error', {
  rules: ['rule_slow'],
  slow: true,
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/api/slow');
    xhr.send();
    setTimeout(() => {
      xhr.abort();
    }, 100);
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'abort', 'event');
    return 'abort event dispatched, and no error event with it';
  },
});

add('aborting before send() does nothing at all', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/plain');
    xhr.abort();
    xhr.send();
    const settled = await waitForXhr(xhr);
    assertEqual(settled.event, 'load', 'event');
    assertEqual(xhr.status, 200, 'status');
    return 'the request still ran, which is what the platform does';
  },
});

add('aborting after the response arrived is a no-op', {
  rules: ['pg_plain'],
  async run() {
    const xhr = new XMLHttpRequest();
    xhr.open('GET', '/pg/plain');
    xhr.send();
    await waitForXhr(xhr);
    assertEqual(xhr.status, 200, 'status before abort');
    xhr.abort();
    assertEqual(xhr.readyState, 0, 'readyState after abort on a finished request');
    return 'nothing was undone and nothing threw';
  },
});
