/**
 * The rule set the playground is written against.
 *
 * One file, loaded by three consumers, so there is only ever one definition of
 * "the rules these test cases expect":
 *
 *   - `scripts/playground.mjs` seeds it into `chrome.storage.local`
 *   - `scripts/e2e.mjs` seeds the same thing and runs the suites headless
 *   - the page itself imports it to show the JSON, and to compare what it
 *     declares against the config the bridge actually pushed -- which is how a
 *     case whose rule is missing reports "not seeded" instead of "failed"
 *
 * Rule ids are stable and are the contract: a test case names the rule it needs
 * by id. Rule *order* is the priority model, so the order in this file is
 * meaningful -- a few groups depend on it deliberately and say so.
 */

export const STORAGE_KEY = 'mocksmith.config.v1';

/* -------------------------------------------------------------------------- */
/* The little DSL. Rules are data; this just keeps the data readable.          */
/* -------------------------------------------------------------------------- */

export function rule(id, name, urlValue, action, methods = ['*'], extra = {}) {
  return {
    id,
    name,
    enabled: extra.enabled ?? true,
    matcher: {
      url: {
        mode: extra.mode ?? 'contains',
        value: urlValue,
        caseSensitive: extra.caseSensitive ?? false,
      },
      methods,
      conditions: extra.conditions ?? [],
      conditionMode: extra.conditionMode ?? 'all',
    },
    action,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function condition(source, key, operator, value = '', extra = {}) {
  return {
    id: extra.id ?? `cond_${source}_${key || 'body'}_${operator}`,
    source,
    key,
    operator,
    value,
    caseSensitive: extra.caseSensitive ?? false,
    enabled: extra.enabled ?? true,
  };
}

export function respond(status, body, extra = {}) {
  return {
    kind: 'respond',
    status,
    statusText: extra.statusText ?? '',
    headers: extra.headers ?? [],
    body: body === null ? { type: 'empty' } : { type: extra.bodyType ?? 'json', value: body },
    delayMs: extra.delayMs ?? 0,
  };
}

export function stream(format, values, extra = {}) {
  return {
    kind: 'stream',
    status: extra.status ?? 200,
    statusText: extra.statusText ?? '',
    headers: extra.headers ?? [],
    format,
    chunks: values.map((value, index) => ({ id: `chunk_${String(index)}`, value })),
    delayMs: extra.delayMs ?? 0,
    intervalMs: extra.intervalMs ?? 30,
    repeat: extra.repeat ?? 1,
  };
}

export function fail(errorType, delayMs = 0) {
  return { kind: 'networkError', errorType, delayMs };
}

export function passthrough() {
  return { kind: 'passthrough' };
}

/**
 * Written as an indented template literal for readability here, and dedented
 * before it is stored: a rule seeded with eight spaces of leading whitespace on
 * every line is not what anyone would have typed.
 */
export function handler(source, extra = {}) {
  const lines = source.replace(/^\n/, '').replace(/\s+$/, '').split('\n');
  const indents = lines
    .filter((line) => line.trim().length > 0)
    .map((line) => (/^\s*/.exec(line) ?? [''])[0].length);
  const strip = indents.length === 0 ? 0 : Math.min(...indents);
  return {
    kind: 'handler',
    code: lines.map((line) => line.slice(strip)).join('\n'),
    delayMs: extra.delayMs ?? 0,
    timeoutMs: extra.timeoutMs ?? 2000,
  };
}

/** A body big enough to be worth streaming, built rather than pasted. */
function bigJson(kilobytes) {
  const row = { sku: 'SKU-00000', name: 'A reasonably long product name', qty: 1 };
  const target = kilobytes * 1024;
  const items = [];
  let size = 2;
  while (size < target) {
    const next = { ...row, sku: `SKU-${String(items.length).padStart(5, '0')}` };
    items.push(next);
    size += JSON.stringify(next).length + 1;
  }
  return JSON.stringify({ items });
}

/* -------------------------------------------------------------------------- */
/* The rule set                                                               */
/* -------------------------------------------------------------------------- */

/**
 * @param {{ port: number, altPort: number }} where
 *   The playground's own origin, and the second origin used by the
 *   cross-origin cases. Two rules name the host on purpose -- that is the shape
 *   the traffic panel displays, and it has to match.
 */
function groupCore({ host }) {
  return [
    /* ====================================================================== */
    /* core -- the original interceptor set. Order matters in this group.     */
    /* ====================================================================== */

    // Deliberately first, to prove a narrow passthrough shadows a broad mock.
    rule('rule_passthrough', 'Keep /api/users/me real', '/api/users/me', passthrough()),
    // Middleware, expressed with the priority model that already exists: a
    // handler above the rule it guards, declining with next() when it does not
    // want the call. Position already means precedence.
    rule(
      'rule_h_gate',
      'Gate users by query',
      '/api/users',
      handler(`
        if (req.query.vip !== '1') return next();
        return { via: 'handler', vip: true };
      `),
    ),
    rule(
      'rule_users404',
      'Users 404',
      '/api/users',
      respond(404, '{"error":{"code":"NOT_FOUND","message":"No such user"}}', {
        headers: [{ name: 'X-Mocked', value: 'yes' }],
      }),
    ),
    rule('rule_slow', 'Slow endpoint', '/api/slow', respond(200, '{"ok":true}', { delayMs: 1500 })),
    rule('rule_boom', 'Boom', '/api/boom', fail('failed')),
    rule('rule_hang', 'Hang', '/api/hang', fail('timeout')),
    // Body deliberately non-empty: a 204 must drop it rather than throw.
    rule('rule_empty', 'No content', '/api/empty', respond(204, '{"ignored":true}')),

    /* -- conditions: the rule only takes the call when the request says so -- */

    rule(
      'rule_admin',
      'Block admin writes',
      '/api/profile',
      respond(403, '{"error":"admin"}'),
      ['POST'],
      {
        conditions: [condition('jsonPath', 'user.role', 'equals', 'admin')],
      },
    ),
    rule('rule_authed', 'Authed only', '/api/secure', respond(200, '{"scope":"full"}'), ['*'], {
      conditions: [condition('header', 'authorization', 'startsWith', 'Bearer ')],
    }),
    rule('rule_cookie', 'Staging cookie', '/api/flag', respond(200, '{"flag":"staging"}'), ['*'], {
      conditions: [condition('cookie', 'mode', 'equals', 'staging')],
    }),
    rule('rule_any', 'Either signal', '/api/either', respond(200, '{"via":"any"}'), ['*'], {
      conditionMode: 'any',
      conditions: [
        condition('query', 'debug', 'equals', '1'),
        condition('header', 'x-debug', 'exists'),
      ],
    }),

    /* -- streams: a body that arrives in pieces rather than all at once -- */

    rule(
      'rule_sse',
      'Server-sent events',
      '/api/events',
      stream('sse', ['{"n":1}', '{"n":2}', '[DONE]']),
    ),
    // Deliberately pretty-printed, to prove ndjson compacts each record onto
    // the one line the format requires.
    rule(
      'rule_ndjson',
      'Newline-delimited json',
      '/api/ndjson',
      stream('ndjson', ['{"a": 1}', '{\n  "b": 2\n}'], { intervalMs: 20, repeat: 2 }),
    ),
    // Repeat 0: never closes on its own, the way a real event source does not.
    rule(
      'rule_forever',
      'Endless event source',
      '/api/forever',
      stream('sse', ['{"tick":1}'], {
        intervalMs: 25,
        repeat: 0,
      }),
    ),

    /* -- handlers: the answer is a function of the request -- */

    rule(
      'rule_h_echo',
      'Echo the request',
      '/api/h/echo',
      handler(`
        return res.status(201).set('X-From', 'handler').json({
          method: req.method,
          path: req.path,
          host: req.host,
          page: req.query.page,
          repeated: req.queryAll.tag,
          auth: req.headers.authorization ?? null,
          cookie: req.cookies.mode ?? null,
          sent: req.body === null ? null : JSON.parse(req.body).note,
          transport: req.transport,
        });
      `),
    ),
    // Counts its own calls, which is the case no declarative rule can express.
    // Keyed by `?run=`, so clicking the case twice is two independent runs
    // rather than a second one that starts at four.
    rule(
      'rule_h_store',
      'Third call fails',
      '/api/h/flaky',
      handler(`
        const key = req.query.run ?? 'default';
        store[key] = (store[key] ?? 0) + 1;
        if (store[key] === 3) return res.status(503).json({ attempt: store[key], down: true });
        return { attempt: store[key], down: false };
      `),
    ),
    // A named group in the pattern, read back as req.params -- an Express route
    // in everything but spelling.
    rule(
      'rule_h_params',
      'Route parameters',
      '/api/h/users/(?<id>\\d+)/posts/(?<postId>\\d+)',
      handler(`return { id: req.params.id, postId: req.params.postId };`),
      ['*'],
      { mode: 'regex' },
    ),
    rule(
      'rule_h_stream',
      'Streamed by a handler',
      '/api/h/stream',
      handler(`
        const rows = [1, 2, 3].map((n) => ({ n, of: 3 }));
        return res.stream(rows, { format: 'ndjson', every: 20 });
      `),
    ),
    // Throws on purpose. The request must not reach the real network.
    rule(
      'rule_h_throws',
      'Handler that throws',
      '/api/h/throws',
      handler(`return nope.notDefined;`),
    ),
    // Never settles, with a short leash, so the timeout is observable.
    rule(
      'rule_h_hangs',
      'Handler that hangs',
      '/api/h/hangs',
      handler(`return new Promise(() => {});`, {
        timeoutMs: 300,
      }),
    ),
    rule(
      'rule_h_xhr',
      'Handler over xhr',
      '/api/h/xhr',
      handler(`
      return { via: 'handler', transport: req.transport };
    `),
    ),
    // A full url including the host, in an anchored mode, written the way the
    // traffic panel displays it -- scheme omitted.
    rule(
      'rule_fullurl',
      'Full url with domain',
      `${host}/api/whoami`,
      respond(200, '{"who":"mocked"}'),
      ['*'],
      {
        mode: 'startsWith',
      },
    ),
  ];
}

function groupRespond() {
  return [
    // One rule per status, generated rather than listed twice. Covers the
    // classes the status pill colours, and the three statuses the Fetch spec
    // forbids a body on.
    ...[
      200, 201, 202, 204, 206, 301, 304, 400, 401, 403, 404, 409, 418, 422, 429, 500, 502, 503, 504,
    ].map((status) =>
      rule(
        `pg_status_${String(status)}`,
        `respond ${String(status)}`,
        `/pg/respond/status/${String(status)}`,
        respond(status, `{"status":${String(status)},"body":"present"}`, {
          headers: status === 301 ? [{ name: 'Location', value: '/pg/respond/status/200' }] : [],
        }),
      ),
    ),
    rule(
      'pg_respond_reason',
      'respond: explicit reason phrase',
      '/pg/respond/reason',
      respond(299, '{"ok":true}', { statusText: 'Totally Fine' }),
    ),
    rule(
      'pg_respond_headers',
      'respond: many headers, including a repeat',
      '/pg/respond/headers',
      respond(200, '{"ok":true}', {
        headers: [
          { name: 'X-One', value: '1' },
          { name: 'X-Two', value: '2' },
          { name: 'X-Repeat', value: 'a' },
          { name: 'X-Repeat', value: 'b' },
          { name: '  ', value: 'dropped: the name is blank' },
        ],
      }),
    ),
    rule(
      'pg_respond_ct_override',
      'respond: an explicit content type wins',
      '/pg/respond/content-type',
      respond(200, '{"ok":true}', {
        headers: [{ name: 'Content-Type', value: 'application/vnd.api+json' }],
      }),
    ),
    rule(
      'pg_respond_text',
      'respond: a text body',
      '/pg/respond/text',
      respond(200, 'plain, and not json', { bodyType: 'text' }),
    ),
    rule('pg_respond_empty', 'respond: no body at all', '/pg/respond/empty', respond(200, null)),
    // Invalid json is a legitimate thing to mock: the client's error path is
    // exactly what you are trying to exercise.
    rule(
      'pg_respond_broken_json',
      'respond: deliberately invalid json',
      '/pg/respond/broken-json',
      respond(200, '{"items":[1,2,'),
    ),
    rule(
      'pg_respond_unicode',
      'respond: unicode survives the round trip',
      '/pg/respond/unicode',
      respond(200, '{"emoji":"🪤","cjk":"偽装","combining":"é","rtl":"مرحبا"}'),
    ),
    rule(
      'pg_respond_array',
      'respond: a top-level array',
      '/pg/respond/array',
      respond(200, '[1,2,3]'),
    ),
    rule(
      'pg_respond_html',
      'respond: html as text',
      '/pg/respond/html',
      respond(200, '<!doctype html><title>mocked</title><p>hello', {
        bodyType: 'text',
        headers: [{ name: 'Content-Type', value: 'text/html;charset=utf-8' }],
      }),
    ),
    rule('pg_respond_big', 'respond: a 48 kB body', '/pg/respond/big', respond(200, bigJson(48))),
    rule(
      'pg_respond_delay',
      'respond: a 400 ms delay',
      '/pg/respond/delay',
      respond(200, '{"waited":true}', { delayMs: 400 }),
    ),
    rule(
      'pg_respond_setcookie',
      'respond: Set-Cookie is dropped by the platform',
      '/pg/respond/set-cookie',
      respond(200, '{"tried":true}', {
        headers: [{ name: 'Set-Cookie', value: 'pg_mocked=1; path=/' }],
      }),
    ),
  ];
}

/* ========================================================================== */
/* matching -- the six url modes, case sensitivity, methods, priority         */
/* ========================================================================== */

function groupMatching({ host }) {
  return [
    rule(
      'pg_match_contains',
      'match: contains (the default)',
      '/pg/match/contains',
      respond(200, '{"mode":"contains"}'),
    ),
    rule(
      'pg_match_equals',
      'match: equals the whole url',
      `${host}/pg/match/equals`,
      respond(200, '{"mode":"equals"}'),
      ['*'],
      {
        mode: 'equals',
      },
    ),
    rule(
      'pg_match_starts',
      'match: startsWith, host-qualified',
      `${host}/pg/match/starts`,
      respond(200, '{"mode":"startsWith"}'),
      ['*'],
      {
        mode: 'startsWith',
      },
    ),
    /*
     * Deliberately broken, and documented as such: `startsWith` is anchored to
     * the start of the *url*, which begins with a scheme and a host. A bare
     * path can never be the start of one, and `contains` is the mode for that.
     */
    rule(
      'pg_match_starts_path',
      'match: startsWith with a bare path never fires',
      '/pg/match/bare-prefix',
      respond(200, '{"mode":"startsWith-path"}'),
      ['*'],
      {
        mode: 'startsWith',
      },
    ),
    rule(
      'pg_match_ends',
      'match: endsWith',
      '/pg/match/ends.json',
      respond(200, '{"mode":"endsWith"}'),
      ['*'],
      {
        mode: 'endsWith',
      },
    ),
    // Wildcard is anchored too, so the pattern names the host rather than
    // starting at the path.
    rule(
      'pg_match_wild',
      'match: wildcard * segment',
      `${host}/pg/match/wild/*/end`,
      respond(200, '{"mode":"wildcard"}'),
      ['*'],
      {
        mode: 'wildcard',
      },
    ),
    rule(
      'pg_match_wild_char',
      'match: wildcard ? single character',
      `${host}/pg/match/char/?/end`,
      respond(200, '{"mode":"wildcard-?"}'),
      ['*'],
      {
        mode: 'wildcard',
      },
    ),
    rule(
      'pg_match_regex',
      'match: regex, unanchored',
      '/pg/match/re/\\d{3}$',
      respond(200, '{"mode":"regex"}'),
      ['*'],
      {
        mode: 'regex',
      },
    ),
    // A pattern that will not compile must never match, or one typo silently
    // hijacks every request on the page.
    rule(
      'pg_match_bad_regex',
      'match: an invalid regex never fires',
      '/pg/match/bad/[',
      respond(200, '{"mode":"invalid"}'),
      ['*'],
      {
        mode: 'regex',
      },
    ),
    rule(
      'pg_match_scheme',
      'match: a scheme-qualified pattern is literal',
      `http://${host}/pg/match/scheme`,
      respond(200, '{"mode":"scheme"}'),
      ['*'],
      {
        mode: 'equals',
      },
    ),
    rule(
      'pg_match_case_off',
      'match: case-insensitive by default',
      '/pg/match/nocase',
      respond(200, '{"case":"insensitive"}'),
    ),
    rule(
      'pg_match_case_on',
      'match: case-sensitive when asked',
      '/pg/match/CaSe',
      respond(200, '{"case":"sensitive"}'),
      ['*'],
      {
        caseSensitive: true,
      },
    ),

    /* -- methods -- */

    rule('pg_method_get', 'method: GET only', '/pg/method/get', respond(200, '{"method":"GET"}'), [
      'GET',
    ]),
    rule(
      'pg_method_set',
      'method: a set of four',
      '/pg/method/set',
      handler(`return { saw: req.method };`),
      ['POST', 'PUT', 'PATCH', 'DELETE'],
    ),
    // A mocked HEAD can carry a body where the network never would. Worth
    // knowing rather than guessing at.
    rule('pg_method_head', 'method: HEAD', '/pg/method/head', respond(200, '{"head":true}'), [
      'HEAD',
    ]),
    rule(
      'pg_method_options',
      'method: OPTIONS',
      '/pg/method/options',
      respond(204, null, {
        headers: [{ name: 'Allow', value: 'GET, POST' }],
      }),
      ['OPTIONS'],
    ),
    // An empty method list means "any", the same as the sentinel.
    rule(
      'pg_method_empty_list',
      'method: an empty list means any',
      '/pg/method/empty-list',
      respond(200, '{"any":true}'),
      [],
    ),

    /* -- priority: position is the entire model -- */

    rule(
      'pg_order_first',
      'order: first match wins',
      '/pg/order/first',
      respond(201, '{"won":"first"}'),
    ),
    rule(
      'pg_order_second',
      'order: never reached',
      '/pg/order/first',
      respond(202, '{"won":"second"}'),
    ),
    rule(
      'pg_order_disabled',
      'order: disabled rules are skipped',
      '/pg/order/disabled',
      respond(500, '{"oops":true}'),
      ['*'],
      {
        enabled: false,
      },
    ),
    // A narrow passthrough carving an exception out of a broad mock.
    rule('pg_scope_keep', 'order: keep one endpoint real', '/pg/order/scope/keep', passthrough()),
    rule(
      'pg_scope_broad',
      'order: mock the rest of the scope',
      '/pg/order/scope',
      respond(404, '{"scope":"mocked"}'),
    ),
    // A pair shadow detection can prove: the second can never fire.
    rule(
      'pg_shadow_broad',
      'shadow: matches everything below it',
      '/pg/shadow',
      respond(200, '{"by":"broad"}'),
    ),
    rule(
      'pg_shadow_hidden',
      'shadow: never fires',
      '/pg/shadow/never',
      respond(404, '{"by":"hidden"}'),
    ),
  ];
}

/* ========================================================================== */
/* conditions -- five sources, eleven operators, two modes                    */
/* ========================================================================== */

function groupConditions() {
  const c = (id, path, conditions, extra = {}) =>
    rule(
      id,
      `cond: ${id.replace('pg_cond_', '').replace(/_/g, ' ')}`,
      `/pg/cond/${path}`,
      respond(200, `{"rule":"${id}"}`),
      extra.methods ?? ['*'],
      {
        conditions,
        conditionMode: extra.conditionMode ?? 'all',
      },
    );

  return [
    c('pg_cond_header_exists', 'header/exists', [condition('header', 'x-flag', 'exists')]),
    c('pg_cond_header_absent', 'header/absent', [condition('header', 'x-flag', 'notExists')]),
    c('pg_cond_header_equals', 'header/equals', [
      condition('header', 'x-env', 'equals', 'staging'),
    ]),
    c('pg_cond_header_not_equals', 'header/not-equals', [
      condition('header', 'x-env', 'notEquals', 'prod'),
    ]),
    c('pg_cond_header_contains', 'header/contains', [
      condition('header', 'x-trace', 'contains', 'abc'),
    ]),
    c('pg_cond_header_not_contains', 'header/not-contains', [
      condition('header', 'x-trace', 'notContains', 'abc'),
    ]),
    c('pg_cond_header_starts', 'header/starts-with', [
      condition('header', 'authorization', 'startsWith', 'Bearer '),
    ]),
    c('pg_cond_header_ends', 'header/ends-with', [
      condition('header', 'x-file', 'endsWith', '.json'),
    ]),
    c('pg_cond_header_matches', 'header/matches', [
      condition('header', 'x-id', 'matches', '^[0-9a-f]{8}$'),
    ]),
    c('pg_cond_header_bad_regex', 'header/bad-regex', [
      condition('header', 'x-id', 'matches', '['),
    ]),
    c('pg_cond_header_case', 'header/case-sensitive', [
      condition('header', 'x-env', 'equals', 'Staging', { caseSensitive: true }),
    ]),
    c('pg_cond_query_exists', 'query/exists', [condition('query', 'debug', 'exists')]),
    c('pg_cond_query_gt', 'query/greater-than', [condition('query', 'page', 'gt', '10')]),
    c('pg_cond_query_lt', 'query/less-than', [condition('query', 'page', 'lt', '10')]),
    c('pg_cond_query_repeated', 'query/repeated-key', [
      condition('query', 'tag', 'equals', 'first'),
    ]),
    c('pg_cond_cookie_equals', 'cookie/equals', [
      condition('cookie', 'pg_env', 'equals', 'staging'),
    ]),
    c('pg_cond_cookie_absent', 'cookie/absent', [condition('cookie', 'pg_never_set', 'notExists')]),
    c('pg_cond_body_contains', 'body/contains', [condition('body', '', 'contains', 'needle')]),
    c('pg_cond_body_matches', 'body/matches', [
      condition('body', '', 'matches', '"total":\\s*\\d+'),
    ]),
    c('pg_cond_json_equals', 'json/equals', [
      condition('jsonPath', 'user.role', 'equals', 'admin'),
    ]),
    c('pg_cond_json_index', 'json/array-index', [
      condition('jsonPath', 'items.0.sku', 'equals', 'A-1'),
    ]),
    c('pg_cond_json_gt', 'json/greater-than', [condition('jsonPath', 'cart.total', 'gt', '100')]),
    c('pg_cond_json_exists', 'json/exists', [condition('jsonPath', 'meta.trace', 'exists')]),
    // A path that lands on an object reads back as its serialized json, so
    // `contains` can still ask about it.
    c('pg_cond_json_object', 'json/object-serialized', [
      condition('jsonPath', 'user', 'contains', '"role"'),
    ]),
    c('pg_cond_all', 'mode/all', [
      condition('header', 'x-env', 'equals', 'staging', { id: 'cond_all_env' }),
      condition('query', 'debug', 'equals', '1', { id: 'cond_all_debug' }),
    ]),
    c(
      'pg_cond_any',
      'mode/any',
      [
        condition('header', 'x-env', 'equals', 'staging', { id: 'cond_any_env' }),
        condition('query', 'debug', 'equals', '1', { id: 'cond_any_debug' }),
      ],
      { conditionMode: 'any' },
    ),
    // A half-written condition must never silently block a rule: switched off,
    // it is not evaluated at all.
    c('pg_cond_disabled_only', 'disabled/only', [
      condition('header', 'x-impossible', 'exists', '', { enabled: false }),
    ]),
    c('pg_cond_disabled_mixed', 'disabled/mixed', [
      condition('header', 'x-env', 'equals', 'staging', { id: 'cond_mixed_env' }),
      condition('header', 'x-impossible', 'exists', '', { id: 'cond_mixed_off', enabled: false }),
    ]),

    /* Two handlers that answer with the facts themselves, so "what could the
       matcher see?" is a question with a printed answer rather than a guess. */
    rule(
      'pg_cond_facts',
      'cond: echo every fact the matcher sees',
      '/pg/cond/facts',
      handler(`
      return {
        method: req.method,
        path: req.path,
        host: req.host,
        origin: req.origin,
        query: req.query,
        queryAll: req.queryAll,
        headers: req.headers,
        cookies: req.cookies,
        transport: req.transport,
      };
    `),
    ),
    rule(
      'pg_cond_bodyshape',
      'cond: echo the serialized payload',
      '/pg/cond/bodyshape',
      handler(`
      return { body: req.body, type: req.headers['content-type'] ?? null };
    `),
    ),
  ];
}

/* ========================================================================== */
/* stream -- a body that arrives in pieces                                    */
/* ========================================================================== */

function groupStream() {
  return [
    // A chunk that already names an SSE field is passed through untouched; a
    // bare one gets the `data:` prefix it would otherwise be missing.
    rule(
      'pg_stream_raw_sse',
      'stream: pre-framed sse fields pass through',
      '/pg/stream/raw-sse',
      stream('sse', ['event: ping\ndata: 1', 'id: 7', 'retry: 5000', ': a comment', '{"bare":1}'], {
        intervalMs: 15,
      }),
    ),
    rule(
      'pg_stream_multiline',
      'stream: every line of a chunk gets data:',
      '/pg/stream/multiline',
      stream('sse', ['line one\nline two']),
    ),
    // Pure whitespace is a blank line, which in SSE ends an event that was
    // never started -- so it is dropped rather than framed.
    rule(
      'pg_stream_blank',
      'stream: a blank chunk is dropped',
      '/pg/stream/blank',
      stream('sse', ['{"a":1}', '   ', '{"b":2}'], { intervalMs: 15 }),
    ),
    rule(
      'pg_stream_text',
      'stream: text is sent verbatim',
      '/pg/stream/text',
      stream('text', ['one\n', 'two\n'], { intervalMs: 15 }),
    ),
    rule(
      'pg_stream_ndjson_raw',
      'stream: ndjson leaves non-json alone',
      '/pg/stream/ndjson-raw',
      stream('ndjson', ['{"a": 1}', 'not json at all'], { intervalMs: 15 }),
    ),
    rule(
      'pg_stream_interval',
      'stream: four chunks, 60 ms apart',
      '/pg/stream/interval',
      stream('sse', ['{"i":1}', '{"i":2}', '{"i":3}', '{"i":4}'], { intervalMs: 60 }),
    ),
    rule(
      'pg_stream_head_delay',
      'stream: the head waits, then chunks follow',
      '/pg/stream/head-delay',
      stream('sse', ['{"i":1}', '{"i":2}'], { delayMs: 300, intervalMs: 20 }),
    ),
    rule(
      'pg_stream_repeat',
      'stream: the list repeats three times',
      '/pg/stream/repeat',
      stream('ndjson', ['{"a":1}', '{"b":2}'], { intervalMs: 15, repeat: 3 }),
    ),
    // 204 forbids a body, so the chunks are dropped rather than streamed.
    rule(
      'pg_stream_204',
      'stream: 204 drops the chunks',
      '/pg/stream/204',
      stream('sse', ['{"a":1}'], {
        status: 204,
      }),
    ),
    rule(
      'pg_stream_ct',
      'stream: an explicit content type wins',
      '/pg/stream/content-type',
      stream('sse', ['{"a":1}'], {
        headers: [{ name: 'Content-Type', value: 'text/plain;charset=utf-8' }],
      }),
    ),
    rule(
      'pg_stream_endless',
      'stream: never closes on its own',
      '/pg/stream/endless',
      stream('sse', ['{"tick":1}'], {
        intervalMs: 30,
        repeat: 0,
      }),
    ),
    rule(
      'pg_stream_slow',
      'stream: slow enough to time out mid-body',
      '/pg/stream/slow',
      stream('text', ['tick\n'], {
        intervalMs: 150,
        repeat: 0,
      }),
    ),
  ];
}

/* ========================================================================== */
/* failures -- the three ways a request can fail                              */
/* ========================================================================== */

function groupFailures() {
  return [
    rule('pg_fail_failed', 'fail: rejects like a dead host', '/pg/fail/failed', fail('failed')),
    rule('pg_fail_aborted', 'fail: rejects as an abort', '/pg/fail/aborted', fail('aborted')),
    rule('pg_fail_timeout', 'fail: never settles', '/pg/fail/timeout', fail('timeout')),
    rule('pg_fail_delayed', 'fail: fails after 300 ms', '/pg/fail/delayed', fail('failed', 300)),
  ];
}

/* ========================================================================== */
/* handlers -- the answer as a function of the request                        */
/* ========================================================================== */

function groupHandlers({ host }) {
  return [
    /* -- the four ways a handler can answer -- */
    rule(
      'pg_h_string',
      'handler: a returned string is text',
      '/pg/h/string',
      handler(`return 'plain words';`),
    ),
    rule(
      'pg_h_array',
      'handler: a returned array is json',
      '/pg/h/array',
      handler(`return [1, 2, 3];`),
    ),
    rule(
      'pg_h_number',
      'handler: a returned number is json',
      '/pg/h/number',
      handler(`return 42;`),
    ),
    rule(
      'pg_h_sent_only',
      'handler: sending without returning',
      '/pg/h/sent-only',
      handler(`
      res.status(202).json({ sent: 'without a return' });
    `),
    ),
    rule(
      'pg_h_status_plain',
      'handler: status and headers apply to a plain return',
      '/pg/h/status-plain',
      handler(`
      res.status(202).set('X-Plain', 'yes');
      return { plain: true };
    `),
    ),

    /* -- the res surface -- */
    rule(
      'pg_h_send_status',
      'handler: res.sendStatus',
      '/pg/h/send-status',
      handler(`return res.sendStatus(418);`),
    ),
    rule(
      'pg_h_end',
      'handler: res.end sends no body and no content type',
      '/pg/h/end',
      handler(`return res.end();`),
    ),
    rule(
      'pg_h_text',
      'handler: res.text stringifies',
      '/pg/h/text',
      handler(`return res.text(42);`),
    ),
    rule(
      'pg_h_set_object',
      'handler: res.set takes an object',
      '/pg/h/set-object',
      handler(`
      return res.set({ 'X-A': '1', 'X-B': '2' }).json({ ok: true });
    `),
    ),
    // The rule's own delay runs before the handler is called, so the two add up.
    rule(
      'pg_h_delay',
      'handler: rule delay and res.delay compose',
      '/pg/h/delay',
      handler(
        `
      return res.delay(250).json({ ok: true });
    `,
        { delayMs: 100 },
      ),
    ),
    rule(
      'pg_h_fail',
      'handler: res.fail raises a network error',
      '/pg/h/fail',
      handler(`
      return res.fail('aborted');
    `),
    ),
    rule(
      'pg_h_passthrough',
      'handler: res.passthrough reaches the real server',
      '/pg/h/passthrough',
      handler(`
      return res.passthrough();
    `),
    ),

    /* -- declining -- */
    // Returning nothing, and returning null, both mean "I am not answering
    // this one". The rule below is what then answers.
    rule(
      'pg_h_decline',
      'handler: declining falls through',
      '/pg/h/decline',
      handler(`
      if (req.query.mode === 'null') return null;
      if (req.query.mode === 'nothing') return;
      if (req.query.mode === 'next') return next();
      return { answered: 'by the handler' };
    `),
    ),
    rule(
      'pg_h_decline_target',
      'handler: what a declined request lands on',
      '/pg/h/decline',
      respond(418, '{"answered":"by the rule below"}'),
    ),

    /* -- the shapes of source people actually paste -- */
    rule(
      'pg_h_async',
      'handler: async and await',
      '/pg/h/async',
      handler(`
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { awaited: true };
    `),
    ),
    rule(
      'pg_h_arrow',
      'handler: an arrow function expression',
      '/pg/h/arrow',
      handler(`
      async (req, res) => ({ form: 'arrow' })
    `),
    ),
    rule(
      'pg_h_export_default',
      'handler: export default function',
      '/pg/h/export-default',
      handler(`
      export default function handler(req, res) {
        return { form: 'export default' };
      }
    `),
    ),
    rule(
      'pg_h_module_exports',
      'handler: module.exports =',
      '/pg/h/module-exports',
      handler(`
      module.exports = function (req, res) {
        return { form: 'module.exports' };
      };
    `),
    ),

    /* -- the request the handler is given -- */
    rule(
      'pg_h_startedat',
      'handler: req.startedAt is when the page asked',
      '/pg/h/started-at',
      handler(`
      return { startedAt: req.startedAt, sandboxNow: Date.now() };
    `),
    ),
    rule(
      'pg_h_body_parse',
      'handler: the payload, parsed',
      '/pg/h/body',
      handler(`
      const sent = JSON.parse(req.body ?? 'null');
      return { note: sent === null ? null : sent.note };
    `),
    ),
    rule(
      'pg_h_wild_params',
      'handler: wildcard captures land in req.params',
      `${host}/pg/h/wild/*/x/?`,
      handler(`
      return { zero: req.params['0'] ?? null, one: req.params['1'] ?? null };
    `),
      ['*'],
      { mode: 'wildcard' },
    ),

    /* -- store: one per rule, surviving between requests -- */
    rule(
      'pg_h_store_a',
      'handler: store, rule A',
      '/pg/h/store-a',
      handler(`
      const key = req.query.run ?? 'default';
      store[key] = (store[key] ?? 0) + 1;
      return { rule: 'a', count: store[key] };
    `),
    ),
    rule(
      'pg_h_store_b',
      'handler: store, rule B',
      '/pg/h/store-b',
      handler(`
      const key = req.query.run ?? 'default';
      store[key] = (store[key] ?? 0) + 1;
      return { rule: 'b', count: store[key] };
    `),
    ),

    /* -- streams from code -- */
    rule(
      'pg_h_stream_default',
      'handler: res.stream defaults to sse',
      '/pg/h/stream-default',
      handler(`
      return res.stream([{ n: 1 }, { n: 2 }], { every: 20 });
    `),
    ),
    rule(
      'pg_h_stream_endless',
      'handler: res.stream with repeat 0 never ends',
      '/pg/h/stream-endless',
      handler(`
      return res.stream(['tick'], { format: 'text', every: 30, repeat: 0 });
    `),
    ),

    /* -- console -- */
    rule(
      'pg_h_console',
      'handler: console reaches the page',
      '/pg/h/console',
      handler(`
      console.log('hello from a handler', { n: 1 });
      console.warn('and a warning');
      return { logged: true };
    `),
    ),

    /* -- every way a handler can go wrong -- */
    rule(
      'pg_h_throw_string',
      'handler: throwing a bare string',
      '/pg/h/throw-string',
      handler(`
      throw 'a bare string';
    `),
    ),
    rule(
      'pg_h_compile_error',
      'handler: source that will not compile',
      '/pg/h/compile-error',
      handler(`return {`),
    ),
    // Synchronous, so no timer inside the sandbox can catch it: the page has to
    // time out independently and replace the frame.
    rule(
      'pg_h_spin',
      'handler: a synchronous infinite loop',
      '/pg/h/spin',
      handler(
        `
      const end = Date.now() + 1200;
      while (Date.now() < end) {}
      return { spun: true };
    `,
        { timeoutMs: 300 },
      ),
    ),
    // A handler cannot answer a synchronous XHR: the code has to run before the
    // response exists, and send() cannot wait for another frame.
    rule(
      'pg_h_sync_xhr',
      'handler: cannot answer a synchronous xhr',
      '/pg/h/sync-xhr',
      handler(`
      return { impossible: true };
    `),
    ),
  ];
}

/* ========================================================================== */
/* transports -- shared rules the fetch and xhr suites both lean on           */
/* ========================================================================== */

function groupTransports() {
  return [
    rule(
      'pg_echo',
      'echo: everything the interceptor saw',
      '/pg/echo',
      handler(`
      return res.set('X-Echo', 'yes').json({
        method: req.method,
        url: req.url,
        path: req.path,
        query: req.query,
        queryAll: req.queryAll,
        headers: req.headers,
        cookies: req.cookies,
        body: req.body,
        transport: req.transport,
      });
    `),
    ),
    rule(
      'pg_plain',
      'plain: a small json body with headers',
      '/pg/plain',
      respond(200, '{"plain":true,"n":1}', {
        headers: [
          { name: 'X-Plain', value: 'yes' },
          { name: 'X-Count', value: '1' },
        ],
      }),
    ),
    rule(
      'pg_binary',
      'plain: a body typed as binary',
      '/pg/binary',
      respond(200, 'not really binary, but typed as it', {
        bodyType: 'text',
        headers: [{ name: 'Content-Type', value: 'application/octet-stream' }],
      }),
    ),
    rule(
      'pg_xml',
      'plain: an xml body, for responseType document',
      '/pg/xml',
      respond(200, '<root><item id="1">one</item></root>', {
        bodyType: 'text',
        headers: [{ name: 'Content-Type', value: 'text/xml' }],
      }),
    ),
    rule(
      'pg_slow_300',
      'plain: a 300 ms delay',
      '/pg/slow-300',
      respond(200, '{"waited":300}', { delayMs: 300 }),
    ),
    rule(
      'pg_slow_1200',
      'plain: a 1200 ms delay',
      '/pg/slow-1200',
      respond(200, '{"waited":1200}', { delayMs: 1200 }),
    ),
  ];
}

/* ========================================================================== */
/* limits -- what is deliberately not intercepted, asserted rather than said  */
/* ========================================================================== */

function groupLimits({ altHost }) {
  return [
    // Layer 1 patches fetch and XHR only. A rule on an image, a stylesheet, an
    // EventSource or a WebSocket url is inert -- those never go through either
    // patch, and the real resource loads.
    rule(
      'pg_limit_img',
      'limit: a rule on an image does nothing',
      '/pg/asset/pixel.png',
      respond(404, '{"mocked":true}'),
    ),
    rule(
      'pg_limit_css',
      'limit: a rule on a stylesheet does nothing',
      '/pg/asset/probe.css',
      respond(200, 'body{}', {
        bodyType: 'text',
      }),
    ),
    rule(
      'pg_limit_eventsource',
      'limit: a rule on an EventSource url does nothing',
      '/pg/limit/eventsource',
      stream('sse', ['{"from":"decoy"}']),
    ),
    rule(
      'pg_limit_ws',
      'limit: a rule on a WebSocket url does nothing',
      '/pg/limit/ws',
      respond(200, '{"mocked":true}'),
    ),
    rule(
      'pg_limit_worker',
      'limit: a worker request is not intercepted',
      '/pg/limit/worker-call',
      respond(200, '{"from":"decoy"}'),
    ),
    rule(
      'pg_limit_beacon',
      'limit: sendBeacon is not intercepted',
      '/pg/limit/beacon',
      respond(200, '{"from":"decoy"}'),
    ),
    // The content scripts run in every frame, so a same-origin iframe is
    // intercepted like the top document. That is a capability, not a limit.
    rule(
      'pg_frame_call',
      'frames: an iframe request is intercepted too',
      '/pg/limit/frame-call',
      respond(200, '{"from":"decoy","frame":true}'),
    ),
    // Mocking happens before the request exists, so a cross-origin mock needs
    // no CORS headers at all. The control case next to it proves the server
    // really does refuse.
    rule(
      'pg_cors_mocked',
      'cross-origin: mocked without any CORS headers',
      `${altHost}/api/mocked-across`,
      respond(200, '{"origin":"mocked"}'),
      ['*'],
      {
        mode: 'startsWith',
      },
    ),
  ];
}

/* -------------------------------------------------------------------------- */
/* Assembly                                                                   */
/* -------------------------------------------------------------------------- */

/** Every rule the playground expects, in priority order. */
export function buildRules({ port, altPort }) {
  const host = `127.0.0.1:${String(port)}`;
  const altHost = `127.0.0.1:${String(altPort)}`;
  return [
    ...groupCore({ host }),
    ...groupRespond(),
    ...groupMatching({ host }),
    ...groupConditions(),
    ...groupStream(),
    ...groupFailures(),
    ...groupHandlers({ host }),
    ...groupTransports(),
    ...groupLimits({ altHost }),
  ];
}

export function buildConfig({ port, altPort, enabled = true }) {
  return { version: 1, enabled, rules: buildRules({ port, altPort }) };
}
