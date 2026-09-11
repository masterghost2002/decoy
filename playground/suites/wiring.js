/**
 * The wiring itself: is Decoy here, did the rule set arrive, and does the page
 * survive being hammered.
 *
 * These run first because when they fail, every other failure downstream is a
 * consequence rather than a finding.
 */
import { assert, assertAtLeast, assertEqual, liveStatus, suite } from '../harness.js';
import { buildRules } from '../rules.mjs';

const add = suite(
  'wiring',
  'Wiring',
  'Is the extension here, is the rule set seeded, does it hold up under load.',
);

add('the extension pushed a config into this page', {
  rules: [],
  doc: 'The isolated content script posts the whole config into the page world on every change. No config means the extension is not loaded, not running on this origin, or was reloaded after this page was.',
  async run() {
    const live = liveStatus();
    assert(live.detected, 'no config has arrived — is Decoy loaded and enabled for this origin?');
    assertEqual(typeof live.config.version, 'number', 'config.version');
    assert(Array.isArray(live.config.rules), 'config.rules should be an array');
    return `${String(live.ruleCount)} rules, received ${String(Math.round((Date.now() - live.receivedAt) / 1000))}s ago`;
  },
});

add('mocking is switched on', {
  rules: [],
  doc: 'The master switch pauses every rule at once. Paused is a legitimate state — it just means nothing below this line can pass.',
  async run() {
    const live = liveStatus();
    assert(live.detected, 'no config has arrived, so there is no switch to read');
    assert(live.enabled, 'mocking is paused by the master switch');
    return 'the master switch is on';
  },
});

add('every rule this playground expects is seeded', {
  rules: [],
  doc: 'Rules are matched by id. A missing one makes its cases skip rather than fail, so this is the case that notices.',
  async run() {
    const live = liveStatus();
    assert(live.detected, 'no config has arrived');
    const expected = buildRules({
      port: Number(location.port || '80'),
      altPort: Number(window.__decoyPlayground?.altPort ?? 0),
    });
    const missing = expected.filter((rule) => !live.seeded.has(rule.id)).map((rule) => rule.id);
    assertEqual(
      missing.length,
      0,
      `${String(missing.length)} of ${String(expected.length)} rules are missing (${missing.slice(0, 5).join(', ')}…)`,
    );
    return `all ${String(expected.length)} rules present`;
  },
});

add('the handler sandbox was advertised to the page', {
  rules: [],
  doc: 'The sandbox is an extension url, which only the isolated world can look up, so it travels with the config. Without it no handler rule can run.',
  async run() {
    const live = liveStatus();
    assert(live.detected, 'no config has arrived');
    assert(
      typeof live.sandboxUrl === 'string' && live.sandboxUrl.startsWith('chrome-extension://'),
      `expected a sandbox url, got ${String(live.sandboxUrl)}`,
    );
    return live.sandboxUrl.replace(/^chrome-extension:\/\//, '').slice(0, 24) + '…';
  },
});

/* -------------------------------------------------------------------------- */
/* Load                                                                       */
/* -------------------------------------------------------------------------- */

add('sixty requests at once all get the right answer', {
  rules: ['pg_echo'],
  doc: 'Traffic is batched by the content bridge, and the batch must never be able to mix up which answer belongs to which call.',
  async run() {
    const startedAt = performance.now();
    const bodies = await Promise.all(
      Array.from({ length: 60 }, (_, index) =>
        fetch(`/pg/echo?i=${String(index)}`).then((response) => response.json()),
      ),
    );
    for (const [index, body] of bodies.entries()) {
      assertEqual(body.query.i, String(index), `answer ${String(index)}`);
    }
    return `60 handler calls in ${String(Math.round(performance.now() - startedAt))}ms, none crossed`;
  },
});

add('a mix of mocked, failed and real requests settles correctly under load', {
  rules: ['pg_plain', 'pg_fail_failed'],
  async run() {
    const work = [];
    for (let index = 0; index < 15; index += 1) {
      work.push(fetch('/pg/plain').then((response) => `mock:${String(response.status)}`));
      work.push(fetch('/api/ping').then((response) => `real:${String(response.status)}`));
      work.push(
        fetch('/pg/fail/failed').then(
          () => 'fail:resolved',
          () => 'fail:rejected',
        ),
      );
    }
    const settled = await Promise.all(work);
    assertEqual(settled.filter((value) => value === 'mock:200').length, 15, 'mocked');
    assertEqual(settled.filter((value) => value === 'real:200').length, 15, 'real');
    assertEqual(settled.filter((value) => value === 'fail:rejected').length, 15, 'failed');
    return '45 requests, three outcomes, all where they belong';
  },
});

add('a request body larger than the capture cap is still sent whole', {
  rules: [],
  doc: 'Payloads are capped at 64 kB *for the traffic log*. The request itself must be untouched — observing a request is not allowed to change it.',
  async run() {
    const payload = 'x'.repeat(100 * 1024);
    const body = await (await fetch('/real/big-upload', { method: 'POST', body: payload })).json();
    assertEqual(body.body.length, payload.length, 'bytes the server received');
    return '100 kB sent, 100 kB arrived, 64 kB captured';
  },
});

add('a matching rule is found among a large rule set without measurable cost', {
  rules: ['pg_plain'],
  doc: 'Matching runs in the page for every request against every rule, so the list has to stay cheap as it grows. This playground seeds well over a hundred.',
  async run() {
    const live = liveStatus();
    assertAtLeast(live.ruleCount, 50, 'rules in the config');

    const startedAt = performance.now();
    for (let index = 0; index < 20; index += 1) {
      await fetch('/pg/plain');
    }
    const each = (performance.now() - startedAt) / 20;
    assert(
      each < 60,
      `${String(Math.round(each))}ms per request is too slow for a page-side decision`,
    );
    return `${String(Math.round(each))}ms per mocked request against ${String(live.ruleCount)} rules`;
  },
});
