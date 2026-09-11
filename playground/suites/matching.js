/**
 * Which request a rule takes: the six url modes, case sensitivity, methods,
 * and the priority model.
 *
 * Every mode gets a matching call *and* a near-miss that has to reach the real
 * server, because "it matched" is only half the claim -- a mode that matched
 * everything would pass the first half of every one of these.
 */
import { assert, assertEqual, suite } from '../harness.js';

const add = suite(
  'match',
  'Matching',
  'Url modes, methods and the first-match-wins priority model.',
);

/** True when the response came from the fixture server rather than a rule. */
async function reachedServer(url, init) {
  const response = await fetch(url, init);
  const body = await response.json();
  return body.server === true;
}

/* -------------------------------------------------------------------------- */
/* Url modes                                                                  */
/* -------------------------------------------------------------------------- */

add('contains matches anywhere in the url', {
  rules: ['pg_match_contains'],
  doc: 'The default mode, and the one that works with a bare path.',
  async run() {
    const body = await (await fetch('/pg/match/contains/and/more?q=1')).json();
    assertEqual(body.mode, 'contains', 'mode');
    assert(await reachedServer('/pg/match/nope'), 'a url without the needle should be real');
    return 'matched mid-url, and left the near-miss alone';
  },
});

add('equals matches the whole url, query string included', {
  rules: ['pg_match_equals'],
  doc: 'Written host-qualified with no scheme -- exactly how the traffic panel displays a url -- which the anchored modes accept.',
  async run() {
    const body = await (await fetch('/pg/match/equals')).json();
    assertEqual(body.mode, 'equals', 'mode');
    assert(
      await reachedServer('/pg/match/equals?x=1'),
      'a query string makes it a different url, so equals must not match',
    );
    return 'exact means exact';
  },
});

add('startsWith anchors at the start of the url', {
  rules: ['pg_match_starts'],
  async run() {
    const body = await (await fetch('/pg/match/starts/anything/after')).json();
    assertEqual(body.mode, 'startsWith', 'mode');
    assert(await reachedServer('/pg/wrong/starts'), 'a different prefix should be real');
    return 'prefix matched, and only as a prefix';
  },
});

add('startsWith with a bare path never fires, by design', {
  rules: ['pg_match_starts_path'],
  doc: 'A url starts with its scheme and host, so a pattern starting with "/" can never be its prefix. Widening this quietly would trade one surprise for another; contains is the mode for a bare path.',
  async run() {
    assert(
      await reachedServer('/pg/match/bare-prefix'),
      'a bare-path startsWith pattern should not match anything',
    );
    return 'the documented limitation holds';
  },
});

add('endsWith anchors at the end', {
  rules: ['pg_match_ends'],
  async run() {
    const body = await (await fetch('/pg/match/ends.json')).json();
    assertEqual(body.mode, 'endsWith', 'mode');
    assert(await reachedServer('/pg/match/ends.json?v=2'), 'a query string moves the end');
    return 'suffix matched';
  },
});

add('wildcard * stands for a whole segment', {
  rules: ['pg_match_wild'],
  doc: 'Wildcard patterns are anchored, so they name the host. "*" spans any run of characters, "?" exactly one.',
  async run() {
    assertEqual((await (await fetch('/pg/match/wild/abc/end')).json()).mode, 'wildcard', 'mode');
    assertEqual(
      (await (await fetch('/pg/match/wild/x/end')).json()).mode,
      'wildcard',
      'short segment',
    );
    assert(await reachedServer('/pg/match/wild/abc/other'), 'the tail has to match too');
    return 'both segments matched the pattern';
  },
});

add('wildcard ? stands for exactly one character', {
  rules: ['pg_match_wild_char'],
  async run() {
    assertEqual(
      (await (await fetch('/pg/match/char/a/end')).json()).mode,
      'wildcard-?',
      'one char',
    );
    assert(await reachedServer('/pg/match/char/ab/end'), 'two characters is one too many');
    return '? is exactly one';
  },
});

add('regex matches the real url, unanchored', {
  rules: ['pg_match_regex'],
  async run() {
    assertEqual((await (await fetch('/pg/match/re/123')).json()).mode, 'regex', 'three digits');
    assert(await reachedServer('/pg/match/re/12'), 'two digits should not match');
    assert(await reachedServer('/pg/match/re/1234'), 'the pattern is anchored at its end');
    return 'the pattern decided, not the mode';
  },
});

add('a regex that will not compile never matches', {
  rules: ['pg_match_bad_regex'],
  doc: 'One typo must not silently hijack every request on the page, so an uncompilable pattern is inert rather than greedy.',
  async run() {
    assert(await reachedServer('/pg/match/bad/['), 'an invalid pattern should match nothing');
    return 'inert, as intended';
  },
});

add('a pattern naming a scheme is taken literally', {
  rules: ['pg_match_scheme'],
  async run() {
    assertEqual((await (await fetch('/pg/match/scheme')).json()).mode, 'scheme', 'relative call');
    assertEqual(
      (await (await fetch(`${location.origin}/pg/match/scheme`)).json()).mode,
      'scheme',
      'absolute call',
    );
    return 'relative and absolute calls both normalize to the same url';
  },
});

add('matching ignores case unless the rule asks', {
  rules: ['pg_match_case_off', 'pg_match_case_on'],
  async run() {
    const loud = await (await fetch('/PG/MATCH/NOCASE')).json();
    assertEqual(loud.case, 'insensitive', 'case-insensitive rule');

    const exact = await (await fetch('/pg/match/CaSe')).json();
    assertEqual(exact.case, 'sensitive', 'case-sensitive rule, exact spelling');
    assert(await reachedServer('/pg/match/case'), 'the wrong case should not match');
    return 'both switches behave';
  },
});

/* -------------------------------------------------------------------------- */
/* Methods                                                                    */
/* -------------------------------------------------------------------------- */

add('a method-specific rule ignores every other method', {
  rules: ['pg_method_get'],
  async run() {
    assertEqual((await (await fetch('/pg/method/get')).json()).method, 'GET', 'GET');
    assert(
      await reachedServer('/pg/method/get', { method: 'POST' }),
      'POST should have reached the server',
    );
    return 'GET taken, POST left real';
  },
});

add('a set of methods takes all of them and nothing else', {
  rules: ['pg_method_set'],
  async run() {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      const body = await (await fetch('/pg/method/set', { method })).json();
      assertEqual(body.saw, method, `${method} intercepted`);
    }
    assert(await reachedServer('/pg/method/set'), 'GET is not in the set');
    return 'four methods in, GET out';
  },
});

add('a lowercase method is normalized before matching', {
  rules: ['pg_method_set'],
  doc: 'fetch uppercases the standard methods itself; the matcher uppercases too, so neither layer can disagree.',
  async run() {
    const body = await (await fetch('/pg/method/set', { method: 'post' })).json();
    assertEqual(body.saw, 'POST', 'method the handler saw');
    return 'lowercase post matched a POST rule';
  },
});

add('an empty method list means any method', {
  rules: ['pg_method_empty_list'],
  async run() {
    for (const method of ['GET', 'POST', 'DELETE']) {
      const body = await (await fetch('/pg/method/empty-list', { method })).json();
      assertEqual(body.any, true, method);
    }
    return 'three methods, one rule, no sentinel needed';
  },
});

add('a mocked HEAD can carry a body, unlike the network', {
  rules: ['pg_method_head'],
  doc: 'A synthesized Response is constructed, not received, so nothing strips the body. Worth knowing before you assert on it.',
  async run() {
    const response = await fetch('/pg/method/head', { method: 'HEAD' });
    assertEqual(response.status, 200, 'status');
    assertEqual(await response.text(), '{"head":true}', 'body');
    return 'the body is there, which a real HEAD would not do';
  },
});

add('OPTIONS is mockable, headers and all', {
  rules: ['pg_method_options'],
  async run() {
    const response = await fetch('/pg/method/options', { method: 'OPTIONS' });
    assertEqual(response.status, 204, 'status');
    assertEqual(response.headers.get('allow'), 'GET, POST', 'allow header');
    return 'a 204 with an Allow header';
  },
});

/* -------------------------------------------------------------------------- */
/* Priority                                                                   */
/* -------------------------------------------------------------------------- */

add('the first enabled match wins, and that is the whole model', {
  rules: ['pg_order_first', 'pg_order_second'],
  async run() {
    const response = await fetch('/pg/order/first');
    assertEqual(response.status, 201, 'status');
    assertEqual((await response.json()).won, 'first', 'which rule answered');
    return 'position decided it; no scores, no specificity';
  },
});

add('a disabled rule is skipped entirely', {
  rules: [],
  doc: 'The rule is seeded switched off, so the request has to reach the network.',
  async run() {
    assert(await reachedServer('/pg/order/disabled'), 'a disabled rule should not answer');
    return 'switched off means invisible';
  },
});

add('a narrow passthrough carves an exception out of a broad mock', {
  rules: ['pg_scope_keep', 'pg_scope_broad'],
  async run() {
    assert(await reachedServer('/pg/order/scope/keep'), 'the passthrough rule should win');
    const mocked = await fetch('/pg/order/scope/anything-else');
    assertEqual(mocked.status, 404, 'the broad rule still applies below it');
    return 'one endpoint real, the rest mocked';
  },
});

add('a rule shadowed by a broader one above it never fires', {
  rules: ['pg_shadow_broad', 'pg_shadow_hidden'],
  doc: 'The pair the rules list flags with "never fires — matches everything this rule does". This asserts the behaviour the badge describes.',
  async run() {
    const response = await fetch('/pg/shadow/never');
    assertEqual(response.status, 200, 'status');
    assertEqual((await response.json()).by, 'broad', 'which rule answered');
    return 'the broad rule above answered a url the hidden one also matches';
  },
});

add('an unmatched request reaches the real network untouched', {
  rules: [],
  async run() {
    const response = await fetch('/api/ping');
    assertEqual(response.status, 200, 'status');
    assertEqual((await response.json()).pong, true, 'body');
    return 'passthrough left the response alone';
  },
});
