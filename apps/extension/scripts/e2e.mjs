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

function rule(id, name, urlValue, action, methods = ['*']) {
  return {
    id,
    name,
    enabled: true,
    matcher: { url: { mode: 'contains', value: urlValue, caseSensitive: false }, methods },
    action,
    createdAt: 0,
    updatedAt: 0,
  };
}

const SEED_CONFIG = {
  version: 1,
  enabled: true,
  rules: [
    // Deliberately first, to prove a narrow passthrough shadows a broad mock.
    rule('rule_passthrough', 'Keep /api/users/me real', '/api/users/me', { kind: 'passthrough' }),
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

  const surfaces = [
    { name: 'tab-rules', url: `chrome-extension://${extensionId}/tab.html`, width: 1280, height: 860 },
    { name: 'tab-traffic', url: null, width: 1280, height: 860, openTraffic: true },
    { name: 'popup', url: `chrome-extension://${extensionId}/popup.html`, width: 420, height: 600 },
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
    await sleep(400);
    if (shot.openTraffic === true) {
      await evaluate(
        cdp,
        sessionId,
        `(() => {
           const tab = [...document.querySelectorAll('button')]
             .find((button) => button.textContent.trim().startsWith('Traffic'));
           tab?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
           tab?.focus();
           return true;
         })()`,
      );
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
         return {
           showsSeededRule: rulesText.includes('Users 404'),
           trafficCount,
           switchedPanel:
             document.querySelector('input[aria-label="Filter requests by url"]') !== null,
           /* Host-qualified on purpose: the bare path also appears in the
              rules pane, so a path-only check could pass without the traffic
              panel ever opening. */
           showsMockedRequest: trafficText.includes('${HOST}/api/boom'),
           showsPassthroughRequest: trafficText.includes('${HOST}/api/ping'),
         };
       })()`,
    );

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
