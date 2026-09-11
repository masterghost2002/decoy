/**
 * End-to-end check for the interceptor, driven over the Chrome DevTools
 * Protocol. Nothing about the extension is stubbed: it launches a real Chrome
 * with the built extension loaded, seeds a rule set through
 * `chrome.storage.local`, loads a fixture page over http, and runs the
 * behavioural scenarios in `fixtures/scenarios.js` inside that page.
 *
 * Config is seeded by writing storage rather than through a test-only hook,
 * because the service worker already watches `chrome.storage.onChanged` for
 * exactly this case.
 *
 *   pnpm --filter @mocksmith/extension build
 *   pnpm --filter @mocksmith/extension e2e
 *
 * Env: CHROME_PATH to override the binary, E2E_HEADED=1 to watch it happen.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(new URL('../../../fixtures', import.meta.url));
const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));
const STORAGE_KEY = 'mocksmith.config.v1';

const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT ?? 9333);
const PAGE_PORT = Number(process.env.E2E_PAGE_PORT ?? 4399);
const HEADED = process.env.E2E_HEADED === '1';
/** When set, the run also writes PNGs of each UI surface here for visual review. */
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? null;
/** `--paper` in both themes, as `getComputedStyle` reports it. */
const PAPER_COLOURS = ['rgb(250, 250, 248)', 'rgb(19, 17, 16)'];

/* -------------------------------------------------------------------------- */
/* Browser discovery                                                          */
/*                                                                            */
/* Chrome 137+ ignores --load-extension on the stable channel, so a normal     */
/* installed Chrome cannot run this. Chrome for Testing still honours it, and  */
/* both Playwright and Puppeteer already cache one locally.                    */
/* -------------------------------------------------------------------------- */

const EXECUTABLE_SUFFIXES = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-linux/chrome',
  'chrome-win64/chrome.exe',
];

/** Highest trailing number wins, so the newest cached build is preferred. */
function buildRank(name) {
  const match = /(\d+)(?!.*\d)/.exec(name);
  return match === null ? 0 : Number(match[1]);
}

function findChromeForTesting() {
  if (process.env.CHROME_PATH !== undefined) return process.env.CHROME_PATH;

  const roots = [
    path.join(homedir(), 'Library/Caches/ms-playwright'),
    path.join(homedir(), '.cache/ms-playwright'),
    path.join(homedir(), '.cache/puppeteer/chrome'),
    path.join(homedir(), 'Library/Caches/puppeteer/chrome'),
  ];

  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      for (const suffix of EXECUTABLE_SUFFIXES) {
        const executable = path.join(root, entry.name, suffix);
        if (existsSync(executable)) found.push({ name: entry.name, executable });
      }
    }
  }

  found.sort((left, right) => buildRank(right.name) - buildRank(left.name));
  return found[0]?.executable ?? null;
}

/* -------------------------------------------------------------------------- */
/* The rule set under test                                                    */
/* -------------------------------------------------------------------------- */

function rule(id, name, urlValue, action, methods = ['*'], extra = {}) {
  return {
    id,
    name,
    enabled: true,
    matcher: {
      url: { mode: extra.mode ?? 'contains', value: urlValue, caseSensitive: false },
      methods,
      conditions: extra.conditions ?? [],
      conditionMode: extra.conditionMode ?? 'all',
    },
    action,
    createdAt: 0,
    updatedAt: 0,
  };
}

function condition(source, key, operator, value = '') {
  return {
    id: `cond_${source}_${key || 'body'}`,
    source,
    key,
    operator,
    value,
    caseSensitive: false,
    enabled: true,
  };
}

function respond(status, body) {
  return {
    kind: 'respond',
    status,
    statusText: '',
    headers: [],
    body: { type: 'json', value: body },
    delayMs: 0,
  };
}

function stream(format, values, { intervalMs = 30, repeat = 1, status = 200 } = {}) {
  return {
    kind: 'stream',
    status,
    statusText: '',
    headers: [],
    format,
    chunks: values.map((value, index) => ({ id: `chunk_${String(index)}`, value })),
    delayMs: 0,
    intervalMs,
    repeat,
  };
}

function handler(code, { timeoutMs = 2000, delayMs = 0 } = {}) {
  return { kind: 'handler', code, delayMs, timeoutMs };
}

const SEED_CONFIG = {
  version: 1,
  enabled: true,
  rules: [
    // Deliberately first, to prove a narrow passthrough shadows a broad mock.
    rule('rule_passthrough', 'Keep /api/users/me real', '/api/users/me', { kind: 'passthrough' }),
    // Middleware, expressed with the priority model that already exists: a
    // handler above the rule it guards, declining with next() when it does not
    // want the call. This is what makes collections unnecessary for the common
    // case -- position already means precedence.
    rule(
      'rule_h_gate',
      'Gate users by query',
      '/api/users',
      handler(`
        if (req.query.vip !== '1') return next();
        return { via: 'handler', vip: true };
      `),
    ),
    rule('rule_users404', 'Users 404', '/api/users', {
      kind: 'respond',
      status: 404,
      statusText: '',
      headers: [{ name: 'X-Mocked', value: 'yes' }],
      body: { type: 'json', value: '{"error":{"code":"NOT_FOUND","message":"No such user"}}' },
      delayMs: 0,
    }),
    rule('rule_slow', 'Slow endpoint', '/api/slow', {
      kind: 'respond',
      status: 200,
      statusText: '',
      headers: [],
      body: { type: 'json', value: '{"ok":true}' },
      delayMs: 1500,
    }),
    rule('rule_boom', 'Boom', '/api/boom', {
      kind: 'networkError',
      errorType: 'failed',
      delayMs: 0,
    }),
    rule('rule_hang', 'Hang', '/api/hang', {
      kind: 'networkError',
      errorType: 'timeout',
      delayMs: 0,
    }),
    rule('rule_empty', 'No content', '/api/empty', {
      kind: 'respond',
      status: 204,
      statusText: '',
      headers: [],
      // Deliberately non-empty: a 204 must drop it rather than throw.
      body: { type: 'json', value: '{"ignored":true}' },
      delayMs: 0,
    }),

    /* -- conditions: the rule only takes the call when the request says so -- */

    // Payload-gated: only the admin POST is intercepted, everyone else is real.
    rule('rule_admin', 'Block admin writes', '/api/profile', respond(403, '{"error":"admin"}'), ['POST'], {
      conditions: [condition('jsonPath', 'user.role', 'equals', 'admin')],
    }),
    // Header-gated.
    rule('rule_authed', 'Authed only', '/api/secure', respond(200, '{"scope":"full"}'), ['*'], {
      conditions: [condition('header', 'authorization', 'startsWith', 'Bearer ')],
    }),
    // Cookie-gated.
    rule('rule_cookie', 'Staging cookie', '/api/flag', respond(200, '{"flag":"staging"}'), ['*'], {
      conditions: [condition('cookie', 'mode', 'equals', 'staging')],
    }),
    // Query-gated, combined with a header, in `any` mode.
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
      stream('sse', ['{"tick":1}'], { intervalMs: 25, repeat: 0 }),
    ),

    /* -- handlers: the answer is a function of the request -- */

    // Everything `req` carries, echoed back, so one assertion covers the whole
    // context the handler is given.
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
    rule(
      'rule_h_store',
      'Third call fails',
      '/api/h/flaky',
      handler(`
        store.calls = (store.calls ?? 0) + 1;
        if (store.calls === 3) return res.status(503).json({ attempt: store.calls, down: true });
        return { attempt: store.calls, down: false };
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

    // A stream, produced by code rather than by a chunk list.
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
      handler(`return new Promise(() => {});`, { timeoutMs: 300 }),
    ),

    // Answers an XHR, which reaches the sandbox by a different road.
    rule(
      'rule_h_xhr',
      'Handler over xhr',
      '/api/h/xhr',
      handler(`return { via: 'handler', transport: req.transport };`),
    ),

    // A full url including the host, in an anchored mode, written the way the
    // traffic panel displays it -- scheme omitted.
    rule('rule_fullurl', 'Full url with domain', `127.0.0.1:${String(PAGE_PORT)}/api/whoami`, respond(200, '{"who":"mocked"}'), ['*'], {
      mode: 'startsWith',
    }),
  ],
};

/* -------------------------------------------------------------------------- */
/* Fixture server                                                             */
/* -------------------------------------------------------------------------- */

const API_RESPONSES = {
  '/api/users/me': { real: true },
  '/api/ping': { pong: true },
};

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript' };

function startFixtureServer() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${String(PAGE_PORT)}`);

    if (url.pathname.startsWith('/api/')) {
      const body = API_RESPONSES[url.pathname] ?? { server: true, path: url.pathname };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
      return;
    }

    const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\/+/, '');
    readFile(path.join(FIXTURES_DIR, name))
      .then((file) => {
        response.writeHead(200, {
          'content-type': CONTENT_TYPES[path.extname(name)] ?? 'application/octet-stream',
          /*
           * Deliberately hostile, and the reason handlers are architected the
           * way they are. No `unsafe-eval`, so building a function from a
           * string is impossible in this page; `frame-src 'self'`, so the page
           * cannot iframe anything either. A hardened app looks like this, and
           * Mocksmith has to work inside one -- the sandbox is an extension
           * frame, which neither directive reaches.
           */
          'content-security-policy':
            "default-src 'self'; script-src 'self'; frame-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'",
        });
        response.end(file);
      })
      .catch(() => {
        response.writeHead(404).end('not found');
      });
  });

  return new Promise((resolve) => {
    server.listen(PAGE_PORT, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

/* -------------------------------------------------------------------------- */
/* Minimal CDP client                                                         */
/* -------------------------------------------------------------------------- */

class Cdp {
  #socket;
  #nextId = 1;
  #pending = new Map();
  #listeners = new Set();

  constructor(socket) {
    this.#socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined) {
        const entry = this.#pending.get(message.id);
        if (entry === undefined) return;
        this.#pending.delete(message.id);
        if (message.error) entry.reject(new Error(`${message.error.message} (${message.method})`));
        else entry.resolve(message.result);
        return;
      }
      for (const listener of this.#listeners) listener(message);
    });
  }

  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', () => {
        reject(new Error(`Could not open a CDP socket at ${url}`));
      }, { once: true });
    });
    return new Cdp(socket);
  }

  send(method, params = {}, sessionId) {
    const id = this.#nextId++;
    const payload = { id, method, params };
    if (sessionId !== undefined) payload.sessionId = sessionId;

    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject, method });
      this.#socket.send(JSON.stringify(payload));
    });
  }

  /** Resolves on the first matching event, or rejects after `timeoutMs`. */
  waitForEvent(method, sessionId, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#listeners.delete(listener);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      const listener = (message) => {
        if (message.method !== method) return;
        if (sessionId !== undefined && message.sessionId !== sessionId) return;
        clearTimeout(timer);
        this.#listeners.delete(listener);
        resolve(message.params);
      };
      this.#listeners.add(listener);
    });
  }

  close() {
    this.#socket.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

async function waitForDebugger(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(DEBUG_PORT)}/json/version`);
      if (response.ok) return await response.json();
    } catch {
      // Chrome is still starting up.
    }
    await sleep(200);
  }
  throw new Error('Chrome never opened its debugging port');
}

/**
 * Chrome ships component extensions with their own workers, so the candidate is
 * confirmed by asking it for its manifest name rather than by guessing from the
 * script filename.
 */
async function findServiceWorker(cdp, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];

  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
    const workers = targetInfos.filter((info) => info.type === 'service_worker');
    seen = workers.map((info) => info.url);

    for (const worker of workers) {
      const sessionId = await attach(cdp, worker.targetId);
      await cdp.send('Runtime.enable', {}, sessionId);
      let name = null;
      try {
        name = await evaluate(cdp, sessionId, 'chrome.runtime.getManifest().name');
      } catch {
        // Not an extension worker, or not ready yet.
      }
      if (name === 'Mocksmith') return { worker, sessionId };
      await cdp.send('Target.detachFromTarget', { sessionId });
    }
    await sleep(250);
  }

  throw new Error(
    `The Mocksmith service worker never appeared as a CDP target.\nService workers seen: ${
      seen.length > 0 ? seen.join(', ') : 'none'
    }`,
  );
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails !== undefined) {
    throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
  }
  return result.value;
}

async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

async function captureSurfaces(cdp, sessionId, extensionId) {
  if (SCREENSHOT_DIR === null) return;
  await mkdir(SCREENSHOT_DIR, { recursive: true });

  /* Small DOM drivers, so a surface that only exists after a click still gets
     reviewed. Each returns quickly; the caller sleeps afterwards. */
  const OPEN_TRAFFIC = `
    const tab = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim().startsWith('Traffic'));
    tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab?.focus();
  `;
  const selectRule = (name) => `
    const row = [...document.querySelectorAll('li button')]
      .find((button) => button.textContent.includes(${JSON.stringify(name)}));
    row?.click();
  `;
  const clickByText = (text) => `
    const target = [...document.querySelectorAll('button')]
      .find((button) => button.textContent.trim() === ${JSON.stringify(text)});
    target?.click();
  `;

  /* React owns these inputs, so a plain `.value =` is swallowed on the next
     render. The native setter plus an input event is what the library listens
     for, and it is the only way to screenshot a dirty form. */
  const typeInto = (selector, text) => `
    {
      const field = document.querySelector(${JSON.stringify(selector)});
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype, 'value',
      ).set;
      setter.call(field, ${JSON.stringify(text)});
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }
  `;

  /* A shadowed pair cannot be seeded into SEED_CONFIG without changing what the
     behavioural checks assert, so the states that need a different rule set
     write their own and let `storage.onChanged` push it through the worker. */
  const reseed = (config) => `
    await chrome.storage.local.set({
      ${JSON.stringify(STORAGE_KEY)}: ${JSON.stringify(config)},
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
  `;

  const shadowedConfig = {
    ...SEED_CONFIG,
    rules: [
      rule('rule_broad', 'Everything under /api', '/api', respond(200, '{"broad":true}')),
      rule('rule_hidden', 'Users 404', '/api/users', respond(404, '{"error":"nope"}')),
      rule('rule_other', 'Orders', '/api/orders', respond(200, '{"ok":true}')),
    ],
  };

  const surfaces = [
    { name: 'tab-rules', width: 1280, height: 860 },
    { name: 'tab-traffic', width: 1280, height: 860, prepare: OPEN_TRAFFIC },
    { name: 'popup', url: `chrome-extension://${extensionId}/popup.html`, width: 780, height: 600 },
    {
      name: 'tab-conditions',
      width: 1280,
      height: 860,
      prepare: selectRule('Block admin writes'),
    },
    {
      name: 'tab-body-expanded',
      width: 1280,
      height: 860,
      prepare: `${selectRule('Users 404')}
        await new Promise((resolve) => setTimeout(resolve, 350));
        ${clickByText('Expand')}`,
    },
    {
      name: 'tab-traffic-detail',
      width: 1280,
      height: 860,
      prepare: `${OPEN_TRAFFIC}
        await new Promise((resolve) => setTimeout(resolve, 500));
        document.querySelector('li button[aria-label^="Inspect"]')?.click();`,
    },
    {
      name: 'tab-traffic-detail-expanded',
      width: 1280,
      height: 860,
      prepare: `${OPEN_TRAFFIC}
        await new Promise((resolve) => setTimeout(resolve, 500));
        document.querySelector('li button[aria-label^="Inspect"]')?.click();
        await new Promise((resolve) => setTimeout(resolve, 400));
        document.querySelector('[aria-label="Expand the panel"]')?.click();`,
    },
    /* -- the states the redesign added, which nothing else exercises -- */
    {
      name: 'tab-stream',
      width: 1280,
      height: 860,
      prepare: selectRule('Server-sent events'),
    },
    {
      name: 'tab-fields',
      width: 1280,
      height: 860,
      prepare: `${selectRule('Users 404')}
        await new Promise((resolve) => setTimeout(resolve, 350));
        ${clickByText('fields')}`,
    },
    {
      name: 'tab-methods',
      width: 1280,
      height: 860,
      prepare: `${selectRule('Users 404')}
        await new Promise((resolve) => setTimeout(resolve, 350));
        document.querySelector('[aria-label^="Request methods"]')?.click();`,
    },
    {
      name: 'tab-match-mode',
      width: 1280,
      height: 860,
      prepare: `${selectRule('Users 404')}
        await new Promise((resolve) => setTimeout(resolve, 350));
        document.querySelector('[aria-label="Url match mode"]')?.click();`,
    },
    {
      name: 'tab-unsaved',
      width: 1280,
      height: 860,
      prepare: `${selectRule('Users 404')}
        await new Promise((resolve) => setTimeout(resolve, 350));
        ${typeInto('[aria-label="Rule name"]', 'Users 404 — edited')}`,
    },
    {
      name: 'tab-handler',
      width: 1280,
      height: 920,
      prepare: `${selectRule('Echo the request')}
        await new Promise((resolve) => setTimeout(resolve, 400));
        ${typeInto('[aria-label="Test request url"]', '/api/h/echo?page=7')}
        await new Promise((resolve) => setTimeout(resolve, 150));
        [...document.querySelectorAll('button')]
          .find((button) => button.textContent.trim() === 'Run')?.click();
        await new Promise((resolve) => setTimeout(resolve, 700));`,
    },
    {
      /* Narrow on purpose. The popover is 19rem wide and used to be laid out
         inside the rules pane, which can be dragged down to 15rem -- so the
         paragraph explaining priority was clipped by the pane explaining it.
         It is portalled and clamped to the viewport now, and this is the shot
         that shows it. */
      name: 'tab-priority-help',
      width: 820,
      height: 620,
      prepare: `document.querySelector('[aria-label="How priority works"]')?.click();`,
    },
    {
      name: 'popup-paused',
      url: `chrome-extension://${extensionId}/popup.html`,
      width: 780,
      height: 600,
      prepare: `document.querySelector('[aria-label="Pause all mocking"]')?.click();`,
    },
    {
      name: 'tab-shadowed',
      width: 1280,
      height: 860,
      prepare: reseed(shadowedConfig),
    },
    {
      name: 'popup-first-run',
      url: `chrome-extension://${extensionId}/popup.html`,
      width: 780,
      height: 600,
      prepare: reseed({ version: 1, enabled: true, rules: [] }),
    },
    // Restores the seed, so a run leaves the profile as it found it.
    {
      name: 'popup-empty-traffic',
      url: `chrome-extension://${extensionId}/popup.html`,
      width: 780,
      height: 600,
      prepare: `${reseed(SEED_CONFIG)}
        ${OPEN_TRAFFIC}`,
    },
  ];

  // Both themes ship, so both get reviewed.
  const shots = ['light', 'dark'].flatMap((scheme) =>
    surfaces.map((surface) => ({ ...surface, scheme, name: `${surface.name}-${scheme}` })),
  );

  for (const shot of shots) {
    await cdp.send(
      'Emulation.setEmulatedMedia',
      { features: [{ name: 'prefers-color-scheme', value: shot.scheme }] },
      sessionId,
    );
    await cdp.send(
      'Emulation.setDeviceMetricsOverride',
      { width: shot.width, height: shot.height, deviceScaleFactor: 2, mobile: false },
      sessionId,
    );

    const target = shot.url ?? `chrome-extension://${extensionId}/tab.html`;
    const loaded = cdp.waitForEvent('Page.loadEventFired', sessionId);
    await cdp.send('Page.navigate', { url: target }, sessionId);
    await loaded;

    /*
     * Transitions off, before anything is clicked.
     *
     * A headless capture does not advance CSS transitions the way a visible
     * tab does, so a screenshot taken after a click can show the *previous*
     * value of any transitioned property -- the selected pill of a segmented
     * control still sitting on the option you just moved away from. The DOM is
     * correct and the picture is not, which is the worst kind of wrong: these
     * images are reviewed as evidence, and one that lies costs an afternoon
     * chasing a bug that does not exist. This one did.
     */
    await evaluate(
      cdp,
      sessionId,
      `(() => {
         const style = document.createElement('style');
         style.textContent =
           '*, *::before, *::after { transition: none !important; animation: none !important; }';
         document.head.append(style);
         return true;
       })()`,
    );
    await sleep(400);
    if (shot.prepare !== undefined) {
      await evaluate(cdp, sessionId, `(async () => { ${shot.prepare}; return true; })()`);
    }
    await sleep(600);

    const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
    const file = path.join(SCREENSHOT_DIR, `${shot.name}.png`);
    await writeFile(file, Buffer.from(data, 'base64'));
    console.log(`screenshot: ${file}`);
  }

  await cdp.send('Emulation.clearDeviceMetricsOverride', {}, sessionId);
}

/* -------------------------------------------------------------------------- */
/* Run                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const chromePath = findChromeForTesting();
  if (chromePath === null) {
    console.error(
      [
        'No Chrome for Testing build found.',
        '',
        'Chrome 137+ ignores --load-extension on the stable channel, so an installed',
        'Chrome cannot load an unpacked extension from the command line. Install a',
        'testing build with either of these, then re-run:',
        '',
        '  npx playwright install chromium',
        '  npx @puppeteer/browsers install chrome@stable',
        '',
        'Or point CHROME_PATH at a Chrome for Testing, Canary or Dev binary.',
      ].join('\n'),
    );
    process.exit(2);
  }
  console.log(`browser: ${chromePath}`);

  const server = await startFixtureServer();
  const userDataDir = await mkdtemp(path.join(tmpdir(), 'mocksmith-e2e-'));

  const chrome = spawn(
    chromePath,
    [
      ...(HEADED ? [] : ['--headless=new']),
      `--remote-debugging-port=${String(DEBUG_PORT)}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${DIST_DIR}`,
      `--load-extension=${DIST_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--window-size=1280,900',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  let cdp;
  let failures = 0;

  try {
    const version = await waitForDebugger();
    cdp = await Cdp.connect(version.webSocketDebuggerUrl);
    await cdp.send('Target.setDiscoverTargets', { discover: true });

    const { worker, sessionId: workerSession } = await findServiceWorker(cdp);
    const extensionId = new URL(worker.url).host;
    console.log(`extension id: ${extensionId}`);

    /* Wait for the worker's own first-run seeding to land before overwriting
       it, or the two writes race and the winner is whichever finished last. */
    const readyDeadline = Date.now() + 10_000;
    for (;;) {
      const stored = await evaluate(
        cdp,
        workerSession,
        `(async () => {
           const bag = await chrome.storage.local.get(${JSON.stringify(STORAGE_KEY)});
           return bag[${JSON.stringify(STORAGE_KEY)}] === undefined ? 'empty' : 'present';
         })()`,
      );
      if (stored === 'present' || Date.now() > readyDeadline) break;
      await sleep(150);
    }

    const seeded = await evaluate(
      cdp,
      workerSession,
      `(async () => {
         await chrome.storage.local.set({ ${JSON.stringify(STORAGE_KEY)}: ${JSON.stringify(SEED_CONFIG)} });
         return 'seeded';
       })()`,
    );
    console.log(`config: ${seeded} (${String(SEED_CONFIG.rules.length)} rules)`);
    // Let the worker's storage listener fan the change out before any page loads.
    await sleep(300);

    const { targetId: pageTargetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const pageSession = await attach(cdp, pageTargetId);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Runtime.enable', {}, pageSession);

    const loaded = cdp.waitForEvent('Page.loadEventFired', pageSession);
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${String(PAGE_PORT)}/` },
      pageSession,
    );
    await loaded;

    const results = await evaluate(cdp, pageSession, 'window.__mocksmith.runAll()');

    console.log('');
    for (const result of results) {
      const label = result.ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m';
      console.log(`${label}  ${result.name}  ${String(result.ms)}ms`);
      console.log(`      ${result.detail}`);
      if (!result.ok) failures += 1;
    }

    /* The extension's own UI, end to end: it has to reach the worker, render
       the seeded rules, and show the traffic those scenarios just produced. */
    const uiLoaded = cdp.waitForEvent('Page.loadEventFired', pageSession);
    await cdp.send(
      'Page.navigate',
      { url: `chrome-extension://${extensionId}/tab.html` },
      pageSession,
    );
    await uiLoaded;
    await sleep(600);

    const HOST = `127.0.0.1:${String(PAGE_PORT)}`;
    const ui = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         /* Read the rules pane before switching tabs: the inactive panel is
            unmounted, so its text is gone afterwards. */
         const rulesText = document.body.innerText;
         const trafficTab = [...document.querySelectorAll('button')]
           .find((button) => button.textContent.trim().startsWith('Traffic'));
         const trafficCount = Number((trafficTab?.textContent ?? '').replace(/\\D/g, '') || '0');

         /* A Radix tab trigger activates on mousedown, and on focus in its
            default automatic mode. A bare .click() fires neither. */
         trafficTab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         trafficTab?.focus();
         await new Promise((resolve) => setTimeout(resolve, 500));

         const trafficText = document.body.innerText;
         const switchedPanel =
           document.querySelector('input[aria-label="Filter requests by url"]') !== null;

         /* "Mock this", end to end. The rule seeded from an observed request
            has to survive the same validation every write goes through: a rule
            the worker will not parse is dropped, the reply the UI then renders
            is missing it, and the button looks like it does nothing at all. */
         const mockThis = await (async () => {
           const before = await chrome.runtime.sendMessage({ type: 'config:get' });
           const button = [...document.querySelectorAll('button')].find(
             (candidate) => candidate.textContent.trim() === 'Mock this',
           );
           if (button === undefined) return { clicked: false, added: 0 };

           button.click();
           await new Promise((resolve) => setTimeout(resolve, 700));
           const after = await chrome.runtime.sendMessage({ type: 'config:get' });

           /* Read before the seed goes back, or the rule being looked for has
              already been taken away again. The new rule is selected in the
              editor, so its generated name is on screen -- one that was stored
              but never shown is a failure too. */
           const showsNewRule = /Mock [A-Z]+ \\//.test(document.body.innerText);

           await chrome.storage.local.set({ ${JSON.stringify(STORAGE_KEY)}: ${JSON.stringify(SEED_CONFIG)} });
           await new Promise((resolve) => setTimeout(resolve, 400));

           return {
             clicked: true,
             added: (after?.config?.rules?.length ?? 0) - (before?.config?.rules?.length ?? 0),
             showsNewRule,
           };
         })();

         return {
           mockThis,
           showsSeededRule: rulesText.includes('Users 404'),
           trafficCount,
           switchedPanel,
           /* Host-qualified on purpose: the bare path also appears in the
              rules pane, so a path-only check could pass without the traffic
              panel ever opening. */
           showsMockedRequest: trafficText.includes('${HOST}/api/boom'),
           showsPassthroughRequest: trafficText.includes('${HOST}/api/ping'),
           /* The response body of a passthrough request is read from a clone
              and reported as a follow-up message, so it arrives after its
              entry. This is the only check that the late path lands. */
           capturedPassthroughBody: await (async () => {
             const reply = await chrome.runtime.sendMessage({ type: 'traffic:list' });
             const entries = reply?.entries ?? [];
             const ping = entries.find(
               (entry) =>
                 entry.outcome === 'passthrough' && entry.url.includes('/api/ping'),
             );
             return ping?.responseBody ?? null;
           })(),
         };
       })()`,
    );

    /* Loading a capture into a stream. There is no other way to exercise this:
       the split is done by format, the format is read off the file, and both
       only happen once a real File has been handed to a real file input. */
    const fileLoad = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

         /* The sse rule on purpose: an ndjson capture loaded into it has to
            flip the format as well, or every record lands in one chunk. */
         const row = [...document.querySelectorAll('li button')].find((button) =>
           button.textContent.includes('Server-sent events'),
         );
         row?.click();
         await pause(450);

         const input = document.querySelector('input[type="file"]');
         if (input === null) return { found: false };

         const transfer = new DataTransfer();
         transfer.items.add(new File(['{"n":1}\\n{"n":2}\\n'], 'capture.ndjson'));
         input.files = transfer.files;
         input.dispatchEvent(new Event('change', { bubbles: true }));
         await pause(600);

         return {
           found: true,
           chunks: [...document.querySelectorAll('textarea[aria-label^="Chunk "]')].map(
             (field) => field.value,
           ),
           format: document.querySelector('[aria-label="Stream format"]')?.textContent ?? '',
           toast: document.querySelector('[role="status"]')?.innerText ?? '',
         };
       })()`,
    );

    /* The handler editor's own runner. It matters that this works from an
       extension page as well as from a content script: the editor cannot
       compile the code itself -- MV3 forbids it there too -- so it asks the
       same sandbox, and what it shows is produced by the code path that will
       answer the real request. */
    const handlerEditor = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const setValue = (field, text) => {
           const proto = field instanceof HTMLTextAreaElement
             ? window.HTMLTextAreaElement.prototype
             : window.HTMLInputElement.prototype;
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, text);
           field.dispatchEvent(new Event('input', { bubbles: true }));
         };

         /* Through a passthrough rule on the way in, which is what a fresh
            page load does: rule 01 is selected by default. */
         const pick = (name) => {
           const row = [...document.querySelectorAll('li button')].find((button) =>
             button.textContent.includes(name),
           );
           row?.click();
         };
         pick('Keep /api/users/m');
         await pause(400);
         pick('Echo the request');
         await pause(500);

         const code = document.querySelector('#mocksmith-handler-code');
         const url = document.querySelector('[aria-label="Test request url"]');
         const method = document.querySelector('[aria-label="Test request method"]');
         const payload = document.querySelector('[aria-label="Test request payload"]');
         if (code === null || url === null) return { editor: false };

         setValue(method, 'POST');
         setValue(url, '/api/h/echo?page=7');
         setValue(payload, JSON.stringify({ note: 'from the editor' }));
         await pause(200);

         const run = [...document.querySelectorAll('button')].find(
           (button) => button.textContent.trim() === 'Run',
         );
         run?.click();
         await pause(900);

         const shown = [...document.querySelectorAll('pre')].map((node) => node.textContent);
         const pressed = [
           ...(document.querySelector('[aria-label="Rule action"]')?.querySelectorAll('button') ??
             []),
         ]
           .filter((button) => button.getAttribute('aria-pressed') === 'true')
           .map((button) => button.textContent.trim());

         return {
           editor: true,
           pressed,
           /* The editor shows the code, not a placeholder for it. */
           showsCode: code.value.includes('res.status(201)'),
           wire: shown.find((text) => (text ?? '').includes('HTTP/1.1')) ?? '',
         };
       })()`,
    );

    /* The floating panel, in a real page. Nothing else exercises the shadow
       root, and the failure mode there is total -- `:root` selects nothing
       inside one, so a missed selector means every colour token resolves to
       nothing and the panel renders as unstyled boxes on top of the site. */
    const { targetId: hostTargetId } = await cdp.send('Target.createTarget', {
      url: `http://127.0.0.1:${String(PAGE_PORT)}/`,
    });
    const hostSession = await attach(cdp, hostTargetId);
    await cdp.send('Page.enable', {}, hostSession);
    await cdp.send('Runtime.enable', {}, hostSession);
    await sleep(600);

    const panelTabId = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         const tabs = await chrome.tabs.query({});
         const tab = tabs.find((entry) => (entry.url ?? '').includes('${HOST}'));
         return tab?.id ?? null;
       })()`,
    );

    const inspectPanel = `(() => {
      const host = document.querySelector('mocksmith-panel');
      if (host === null) return { mounted: false };
      const surface = host.shadowRoot?.querySelector('.mocksmith-surface') ?? null;
      if (surface === null) return { mounted: true, styled: false };
      const style = getComputedStyle(surface);
      return {
        mounted: true,
        styled: true,
        /* Resolved from a custom property declared on \`:host\`. If the token
           blocks were still \`:root\`-only this would come back transparent. */
        background: style.backgroundColor,
        radius: style.borderRadius,
        text: surface.innerText.slice(0, 400),
        width: surface.getBoundingClientRect().width,
      };
    })()`;

    await evaluate(
      cdp,
      pageSession,
      `chrome.runtime.sendMessage({ type: 'panel:toggle', tabId: ${String(panelTabId)} })`,
    );
    console.log(`panel: injected into tab ${String(panelTabId)}`);
    // Generous: the panel bundle is half a megabyte and is being parsed,
    // executed and mounted, and its stylesheet fetched, on a cold page.
    await sleep(1800);
    const panel = await evaluate(cdp, hostSession, inspectPanel);

    /* The traffic path *inside the panel*. Everything the panel portals -- a
       menu, a tooltip, this sheet -- has to land inside the shadow root, or it
       renders in the host page with none of the stylesheet that styles it. The
       tab and the popup cannot catch that: their portal container is the same
       document as their styles. */
    const panelTraffic = await evaluate(
      cdp,
      hostSession,
      `(async () => {
         const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const host = document.querySelector('mocksmith-panel');
         const shadow = host?.shadowRoot ?? null;
         if (shadow === null) return { reached: false };

         const tab = [...shadow.querySelectorAll('button')].find((button) =>
           button.textContent.trim().startsWith('Traffic'),
         );
         tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
         tab?.focus();
         await pause(600);

         /* The panel was injected into a freshly loaded page, so its own tab
            has little or no traffic of its own; the log is unscoped first. */
         const scope = [...shadow.querySelectorAll('button')].find(
           (button) => button.textContent.trim() === 'this tab',
         );
         scope?.click();
         await pause(400);

         const row = [...shadow.querySelectorAll('button')].find((button) =>
           (button.getAttribute('aria-label') ?? '').startsWith('Inspect '),
         );
         if (row === undefined) return { reached: true, rows: false };
         row.click();
         await pause(700);

         const sheet =
           shadow.querySelector('[role="dialog"]') ??
           document.body.querySelector('[role="dialog"]');
         const sheetInShadowNow = shadow.querySelector('[role="dialog"]') !== null;
         const sheetInPageNow = document.body.querySelector('[role="dialog"]') !== null;
         const sheetSnapshot = (sheet?.innerText ?? '').slice(0, 120);

         /* Out of the sheet and back to the list, then the button the report
            was about. The panel writes through the same worker as the tab, but
            from a content script rather than an extension page -- so it is the
            one surface where "Mock this" can fail on its own. */
         document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
         await pause(400);

         const mock = [...shadow.querySelectorAll('button')].find((button) =>
           (button.getAttribute('aria-label') ?? '').startsWith('Create a rule for '),
         );
         mock?.click();
         await pause(800);

         const surface = shadow.querySelector('.mocksmith-surface');
         return {
           reached: true,
           rows: true,
           mockClicked: mock !== undefined,
           /* The panel switches to Rules and selects the new rule, so its
              generated name is on screen in the panel's own editor. */
           showsNewRule: /Mock [A-Z]+ \\//.test(surface?.innerText ?? ''),
           /* Where the sheet ended up. Inside is the fix; in the page is the
              bug, and an unstyled dialog in someone else's document is what
              "clicking a request went white" looks like. */
           sheetInShadow: sheetInShadowNow,
           sheetInPage: sheetInPageNow,
           /* A crash in the tree unmounts the React root and leaves the frame
              an empty rounded box. */
           panelStillHasContent: (surface?.innerText ?? '').trim().length > 0,
           sheetText: sheetSnapshot,
         };
       })()`,
    );

    const panelWrote = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         const reply = await chrome.runtime.sendMessage({ type: 'config:get' });
         const rules = reply?.config?.rules ?? [];

         /* The seed goes back either way, so the screenshots that follow and
            the next run both start from the rule set they expect. */
         await chrome.storage.local.set({ ${JSON.stringify(STORAGE_KEY)}: ${JSON.stringify(SEED_CONFIG)} });
         return {
           count: rules.length,
           seeded: ${String(SEED_CONFIG.rules.length)},
           lastName: rules.length === 0 ? '' : rules[rules.length - 1].name,
         };
       })()`,
    );

    if (SCREENSHOT_DIR !== null && panel.mounted === true) {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, hostSession);
      const file = path.join(SCREENSHOT_DIR, 'panel-over-page.png');
      await writeFile(file, Buffer.from(data, 'base64'));
      console.log(`screenshot: ${file}`);
    }

    // Injecting a second time is how the panel is dismissed.
    await evaluate(
      cdp,
      pageSession,
      `chrome.runtime.sendMessage({ type: 'panel:toggle', tabId: ${String(panelTabId)} })`,
    );
    await sleep(900);
    const afterToggle = await evaluate(cdp, hostSession, inspectPanel);

    console.log('');
    const uiChecks = [
      ['ui: renders the seeded rules', ui.showsSeededRule],
      ['ui: traffic panel opens', ui.switchedPanel],
      [
        `ui: traffic log holds every request (${String(ui.trafficCount)})`,
        ui.trafficCount >= results.length,
      ],
      ['ui: shows a mocked request', ui.showsMockedRequest],
      ['ui: shows a passthrough request', ui.showsPassthroughRequest],
      [
        'ui: captures a passthrough response body for Mock this',
        typeof ui.capturedPassthroughBody === 'string' &&
          ui.capturedPassthroughBody.includes('pong'),
      ],
      [
        'ui: Mock this stores the rule it seeds',
        ui.mockThis?.clicked === true && ui.mockThis.added === 1,
      ],
      ['ui: Mock this opens the new rule in the editor', ui.mockThis?.showsNewRule === true],
      [
        `ui: a loaded capture becomes one chunk per record (${JSON.stringify(fileLoad.chunks)})`,
        Array.isArray(fileLoad.chunks) &&
          fileLoad.chunks.length === 2 &&
          fileLoad.chunks[0] === '{"n":1}' &&
          fileLoad.chunks[1] === '{"n":2}',
      ],
      [
        `ui: the file's own format wins over the one selected (${String(fileLoad.format)})`,
        typeof fileLoad.format === 'string' && fileLoad.format.includes('ndjson'),
      ],
      [
        'ui: loading a file says what it did, and offers it back',
        typeof fileLoad.toast === 'string' &&
          fileLoad.toast.includes('capture.ndjson') &&
          fileLoad.toast.includes('Undo'),
      ],
      ['ui: the handler editor shows the rule\'s code', handlerEditor.showsCode === true],
      [
        `ui: the action picker marks Handler as selected (${JSON.stringify(handlerEditor.pressed)})`,
        JSON.stringify(handlerEditor.pressed) === '["Handler"]',
      ],
      [
        'ui: Run answers from the same sandbox the interceptor uses',
        typeof handlerEditor.wire === 'string' &&
          handlerEditor.wire.includes('201') &&
          handlerEditor.wire.includes('X-From: handler') &&
          handlerEditor.wire.includes('from the editor') &&
          handlerEditor.wire.includes('"page": "7"'),
      ],
      ['panel: mounts a shadow root into the page', panel.mounted === true],
      [
        // Either paper is a pass; which one depends on the host's colour
        // scheme. What is being checked is that the token resolved at all --
        // if the blocks were still `:root`-only this would be transparent.
        `panel: the palette resolves inside the shadow root (${String(panel.background)})`,
        PAPER_COLOURS.includes(panel.background),
      ],
      [`panel: keeps its rounded corners (${String(panel.radius)})`, panel.radius === '14px'],
      [
        'panel: renders the rule editor, not an unstyled stack',
        typeof panel.text === 'string' && panel.text.includes('Mocksmith'),
      ],
      [
        `panel: sizes itself to its own box, not the window (${String(panel.width)}px)`,
        typeof panel.width === 'number' && panel.width > 0 && panel.width < 1280,
      ],
      [
        'panel: a request row opens the detail sheet',
        panelTraffic.rows === true && panelTraffic.sheetText.includes('Request detail'),
      ],
      [
        'panel: the sheet lands inside the shadow root, where its styles are',
        panelTraffic.sheetInShadow === true && panelTraffic.sheetInPage === false,
      ],
      [
        'panel: opening a request does not blank the panel',
        panelTraffic.panelStillHasContent === true,
      ],
      [
        `panel: Mock this writes through from a content script (${String(panelWrote.count)} rules)`,
        panelTraffic.mockClicked === true && panelWrote.count === panelWrote.seeded + 1,
      ],
      [
        `panel: Mock this opens the new rule in the panel (${String(panelWrote.lastName)})`,
        panelTraffic.showsNewRule === true,
      ],
      ['panel: a second toggle takes it away again', afterToggle.mounted === false],
    ];
    for (const [name, ok] of uiChecks) {
      console.log(`${ok ? '\u001b[32mPASS\u001b[0m' : '\u001b[31mFAIL\u001b[0m'}  ${name}`);
      if (!ok) failures += 1;
    }

    await captureSurfaces(cdp, pageSession, extensionId);

    const total = results.length + uiChecks.length;
    console.log('');
    console.log(`${String(total - failures)}/${String(total)} checks passed`);
  } finally {
    cdp?.close();
    chrome.kill();
    server.close();
    // Chrome can still be releasing file handles as it exits.
    await sleep(300);
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
