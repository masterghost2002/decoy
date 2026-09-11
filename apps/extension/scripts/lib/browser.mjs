/**
 * Driving a real Chrome with the built extension loaded.
 *
 * Shared by `e2e.mjs`, which runs the playground headless and asserts, and by
 * `playground.mjs`, which opens the same thing for a person to click around in.
 * Both need exactly this: find a Chrome that will load an unpacked extension,
 * talk to it over the DevTools protocol, find Decoy's service worker, and write
 * a config into its storage.
 *
 * Everything here is deliberately dependency-free. A test harness that needs
 * its own install step is a test harness people stop running.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

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

export function findChromeForTesting() {
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

export const MISSING_CHROME_MESSAGE = [
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
].join('\n');

/* -------------------------------------------------------------------------- */
/* Minimal CDP client                                                         */
/* -------------------------------------------------------------------------- */

export class Cdp {
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
      socket.addEventListener(
        'error',
        () => {
          reject(new Error(`Could not open a CDP socket at ${url}`));
        },
        { once: true },
      );
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

export const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export async function attach(cdp, targetId) {
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

export async function evaluate(cdp, sessionId, expression) {
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

export async function waitForDebugger(debugPort, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${String(debugPort)}/json/version`);
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
export async function findServiceWorker(cdp, name = 'Decoy', timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let seen = [];

  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets', { filter: [{}] });
    const workers = targetInfos.filter((info) => info.type === 'service_worker');
    seen = workers.map((info) => info.url);

    for (const worker of workers) {
      const sessionId = await attach(cdp, worker.targetId);
      await cdp.send('Runtime.enable', {}, sessionId);
      let manifestName = null;
      try {
        manifestName = await evaluate(cdp, sessionId, 'chrome.runtime.getManifest().name');
      } catch {
        // Not an extension worker, or not ready yet.
      }
      if (manifestName === name) return { worker, sessionId };
      await cdp.send('Target.detachFromTarget', { sessionId });
    }
    await sleep(250);
  }

  throw new Error(
    `The ${name} service worker never appeared as a CDP target.\nService workers seen: ${
      seen.length > 0 ? seen.join(', ') : 'none'
    }`,
  );
}

/* -------------------------------------------------------------------------- */
/* Launching                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Starts Chrome with the built extension loaded and connects to it.
 *
 * Returns the process, a connected CDP client, the extension id and a `close`
 * that also removes the throwaway profile -- so neither caller has to remember
 * the order those come down in.
 */
export async function launchWithExtension({
  distDir,
  debugPort,
  headed = false,
  windowSize = '1280,900',
}) {
  const chromePath = findChromeForTesting();
  if (chromePath === null) {
    const error = new Error(MISSING_CHROME_MESSAGE);
    error.code = 'NO_CHROME';
    throw error;
  }

  const userDataDir = await mkdtemp(path.join(tmpdir(), 'decoy-'));
  const chrome = spawn(
    chromePath,
    [
      ...(headed ? [] : ['--headless=new']),
      `--remote-debugging-port=${String(debugPort)}`,
      `--user-data-dir=${userDataDir}`,
      `--disable-extensions-except=${distDir}`,
      `--load-extension=${distDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      `--window-size=${windowSize}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  const version = await waitForDebugger(debugPort);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);
  await cdp.send('Target.setDiscoverTargets', { discover: true });

  const { worker, sessionId: workerSession } = await findServiceWorker(cdp);
  const extensionId = new URL(worker.url).host;

  return {
    chromePath,
    chrome,
    cdp,
    workerSession,
    extensionId,
    userDataDir,
    async close() {
      try {
        cdp.close();
      } catch {
        // Already gone.
      }
      chrome.kill();
      // Chrome can still be releasing file handles as it exits, and a profile
      // that will not delete must never be the error a run reports.
      await sleep(300);
      await rm(userDataDir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Seeding                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Writes a config through `chrome.storage.local`, which is what the worker
 * already watches for external changes -- so this needs no test-only hook in
 * the extension itself.
 *
 * Waits for the worker's own first-run seeding to land before overwriting it,
 * or the two writes race and the winner is whichever finished last.
 */
export async function seedConfig(cdp, workerSession, storageKey, config, { settleMs = 400 } = {}) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const stored = await evaluate(
      cdp,
      workerSession,
      `(async () => {
         const bag = await chrome.storage.local.get(${JSON.stringify(storageKey)});
         return bag[${JSON.stringify(storageKey)}] === undefined ? 'empty' : 'present';
       })()`,
    );
    if (stored === 'present' || Date.now() > deadline) break;
    await sleep(150);
  }

  await evaluate(
    cdp,
    workerSession,
    `(async () => {
       await chrome.storage.local.set({ ${JSON.stringify(storageKey)}: ${JSON.stringify(config)} });
       return 'seeded';
     })()`,
  );
  // Let the worker's storage listener fan the change out before any page loads.
  await sleep(settleMs);
  return config.rules.length;
}
