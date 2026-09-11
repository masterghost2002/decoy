/**
 * End-to-end check, driven over the Chrome DevTools Protocol. Nothing about the
 * extension is stubbed: it launches a real Chrome with the built extension
 * loaded, seeds the playground's rule set through `chrome.storage.local`,
 * serves the playground over http, and runs every one of its cases inside that
 * page -- then drives the extension's own UI and the floating panel.
 *
 * The behavioural half lives in `playground/`, not here, and that is
 * deliberate: the same cases a person clicks through when something looks wrong
 * are the ones CI runs, so there is only ever one definition of "working".
 *
 * Config is seeded by writing storage rather than through a test-only hook,
 * because the service worker already watches `chrome.storage.onChanged` for
 * exactly this case.
 *
 *   pnpm --filter @decoy/extension build
 *   pnpm --filter @decoy/extension e2e
 *
 * Env: CHROME_PATH to override the binary, E2E_HEADED=1 to watch it happen.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildConfig, respond, rule, STORAGE_KEY } from '../../../playground/rules.mjs';
import { startAltOriginServer, startPlaygroundServer } from '../../../playground/server.mjs';
import {
  attach,
  evaluate,
  launchWithExtension,
  MISSING_CHROME_MESSAGE,
  seedConfig,
  sleep,
} from './lib/browser.mjs';

const DIST_DIR = fileURLToPath(new URL('../dist', import.meta.url));

const DEBUG_PORT = Number(process.env.E2E_DEBUG_PORT ?? 9333);
const PAGE_PORT = Number(process.env.E2E_PAGE_PORT ?? 4399);
/* The second origin the cross-origin cases need. Below the page port, so a
   playground left running on 4400/4401 does not collide with a test run. */
const ALT_PORT = PAGE_PORT - 1;
/** The agent bridge, and one above it for the wrong-token check. */
const AGENT_PORT = Number(process.env.E2E_AGENT_PORT ?? 18_787);
const HEADED = process.env.E2E_HEADED === '1';
/** When set, the run also writes PNGs of each UI surface here for visual review. */
const SCREENSHOT_DIR = process.env.E2E_SCREENSHOT_DIR ?? null;
/** `--paper` in both themes, as `getComputedStyle` reports it. */
const PAPER_COLOURS = ['rgb(250, 250, 248)', 'rgb(19, 17, 16)'];

/** The rule set under test: the playground's, in full. */
const SEED_CONFIG = buildConfig({ port: PAGE_PORT, altPort: ALT_PORT });

/* -------------------------------------------------------------------------- */
/* Screenshots                                                                */
/* -------------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------------- */
/* Agent control                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Drives Decoy the way an MCP client does: start the real bridge, switch agent
 * control on the way the UI does, then make the browser do real work over the
 * socket.
 *
 * The bridge is imported from `apps/mcp/dist`, not reimplemented here, so a
 * change to the protocol breaks this rather than quietly passing against a stub
 * that still speaks the old one.
 */
async function checkAgentBridge(cdp, workerSession) {
  const result = {
    connected: false,
    status: null,
    created: false,
    storedInConfig: false,
    answered: 0,
    winsNamed: false,
    updateKeptUrl: false,
    sawTraffic: false,
    deleted: false,
    refusedMissing: false,
    refusedBadToken: false,
  };

  const { Bridge } = await import('../../mcp/dist/bridge.js').catch(() => {
    throw new Error(
      'apps/mcp/dist is missing. Run `pnpm build` before `pnpm e2e`: the agent checks drive the real bridge.',
    );
  });

  const token = 'e2e-token-not-a-secret';

  const bridge = new Bridge({ port: AGENT_PORT, token, connectWaitMs: 8000 });
  await bridge.listen();

  /*
   * Written straight to storage, not sent as a message: `sendMessage` from
   * inside the worker never reaches the worker's own listener, and the
   * `storage.onChanged` path is the one a second surface uses anyway.
   */
  const setAgent = (enabled, port) =>
    evaluate(
      cdp,
      workerSession,
      `(async () => {
         await chrome.storage.local.set({
           'decoy.agent.v1': { enabled: ${String(enabled)}, port: ${String(port)}, token: ${JSON.stringify(token)} },
         });
         return 'written';
       })()`,
    );

  try {
    await setAgent(true, AGENT_PORT);

    result.connected = await bridge.waitForBrowser(8000);
    if (!result.connected) return result;

    result.status = await bridge.call({ kind: 'status' });

    /* Create. A rule from an agent goes to the top, because position is the
       whole priority model and one underneath a broad rule does nothing. */
    const created = await bridge.call({
      kind: 'rules.create',
      spec: {
        name: 'Written by an agent',
        url: '/pg/agent/probe',
        respond: { status: 418, json: { via: 'agent' } },
      },
    });
    const ruleId = created?.rule?.id ?? '';
    result.created = created?.rule?.index === 0 && ruleId.length > 0;

    /* In the real config, through the validation every write goes through --
       not in a side table only the agent can see. */
    const stored = await evaluate(
      cdp,
      workerSession,
      `(async () => {
         const bag = await chrome.storage.local.get('decoy.config.v1');
         const rules = bag['decoy.config.v1']?.rules ?? [];
         const rule = rules.find((entry) => entry.id === ${JSON.stringify(ruleId)});
         return rule === undefined ? null : { name: rule.name, status: rule.action.status };
       })()`,
    );
    result.storedInConfig = stored?.name === 'Written by an agent' && stored.status === 418;

    /* The page has to see it now: a rule that only takes effect after a reload
       is a rule an agent cannot usefully write. */
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const probeSession = await attach(cdp, targetId);
    await cdp.send('Page.enable', {}, probeSession);
    await cdp.send('Runtime.enable', {}, probeSession);
    const probeLoaded = cdp.waitForEvent('Page.loadEventFired', probeSession);
    await cdp.send(
      'Page.navigate',
      { url: `http://127.0.0.1:${String(PAGE_PORT)}/` },
      probeSession,
    );
    await probeLoaded;
    await sleep(400);
    result.answered = await evaluate(
      cdp,
      probeSession,
      `fetch('/pg/agent/probe').then((response) => response.status)`,
    );

    const wins = await bridge.call({
      kind: 'match.test',
      url: `http://127.0.0.1:${String(PAGE_PORT)}/pg/agent/probe`,
    });
    result.winsNamed = wins?.matched === true && wins.rule?.id === ruleId;

    /* An update naming only a status must not drop the url it matches on. */
    await bridge.call({ kind: 'rules.update', id: ruleId, spec: { respond: { status: 503 } } });
    const afterUpdate = await bridge.call({ kind: 'rules.get', id: ruleId });
    result.updateKeptUrl =
      afterUpdate?.matcher?.url?.value === '/pg/agent/probe' && afterUpdate.action?.status === 503;

    /* Traffic is batched by the content bridge before it reaches the worker,
       so the honest assertion is "it turns up", not "it is there this
       millisecond". */
    for (let attempt = 0; attempt < 10 && !result.sawTraffic; attempt += 1) {
      const traffic = await bridge.call({
        kind: 'traffic.list',
        limit: 50,
        urlContains: '/pg/agent/probe',
      });
      result.sawTraffic = (traffic?.entries ?? []).some((entry) =>
        entry.url.includes('/pg/agent/probe'),
      );
      if (!result.sawTraffic) await sleep(200);
    }

    await bridge.call({ kind: 'rules.delete', id: ruleId });
    result.deleted = await evaluate(
      cdp,
      probeSession,
      `fetch('/pg/agent/probe').then((response) => response.json()).then((body) => body.server === true)`,
    );

    // A command for a rule that is gone has to be refused. Silently doing
    // nothing is the failure mode an agent builds on top of.
    result.refusedMissing = await bridge
      .call({ kind: 'rules.get', id: ruleId })
      .then(() => false)
      .catch(() => true);

    /* The security property: a bridge with a different token gets nothing. The
       extension closes on 4401 and stops retrying, which is why this second
       bridge never sees a browser. */
    const impostor = new Bridge({
      port: AGENT_PORT + 1,
      token: 'the-wrong-token',
      connectWaitMs: 500,
    });
    await impostor.listen();
    await setAgent(true, AGENT_PORT + 1);
    await sleep(1500);
    result.refusedBadToken = !impostor.connected;
    impostor.close();
  } finally {
    // Left switched off, so a run leaves the profile as it found it.
    await setAgent(false, AGENT_PORT).catch(() => undefined);
    bridge.close();
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Main                                                                       */
/* -------------------------------------------------------------------------- */

async function main() {
  const servers = [
    await startPlaygroundServer({ port: PAGE_PORT, altPort: ALT_PORT }),
    await startAltOriginServer({ port: ALT_PORT }),
  ];

  let session;
  try {
    session = await launchWithExtension({
      distDir: DIST_DIR,
      debugPort: DEBUG_PORT,
      headed: HEADED,
    });
  } catch (error) {
    for (const server of servers) server.close();
    if (error.code === 'NO_CHROME') {
      console.error(MISSING_CHROME_MESSAGE);
      process.exit(2);
    }
    throw error;
  }

  const { cdp, workerSession, extensionId } = session;
  console.log(`browser: ${session.chromePath}`);
  console.log(`extension id: ${extensionId}`);

  let failures = 0;

  try {
    const seeded = await seedConfig(cdp, workerSession, STORAGE_KEY, SEED_CONFIG);
    console.log(`config: seeded (${String(seeded)} rules)`);

    const { targetId: pageTargetId } = await cdp.send('Target.createTarget', {
      url: 'about:blank',
    });
    const pageSession = await attach(cdp, pageTargetId);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Runtime.enable', {}, pageSession);

    const loaded = cdp.waitForEvent('Page.loadEventFired', pageSession);
    await cdp.send('Page.navigate', { url: `http://127.0.0.1:${String(PAGE_PORT)}/` }, pageSession);
    await loaded;

    /*
     * Started and then polled, rather than awaited in one evaluation. The
     * playground makes several hundred requests and takes the better part of a
     * minute; a single `Runtime.evaluate` with `awaitPromise` held open that
     * long gets its promise collected out from under it, and the run dies with
     * "Promise was collected" rather than a result.
     */
    await evaluate(
      cdp,
      pageSession,
      `(() => {
         window.__e2e = { done: false, results: null };
         window.__decoy.runAll().then(
           (results) => {
             window.__e2e = { done: true, results };
           },
           (error) => {
             window.__e2e = {
               done: true,
               results: [{ name: 'playground: runAll', ok: false, status: 'fail', detail: String(error), ms: 0 }],
             };
           },
         );
         return 'started';
       })()`,
    );

    let results = null;
    const runDeadline = Date.now() + 300_000;
    while (Date.now() < runDeadline) {
      const snapshot = await evaluate(
        cdp,
        pageSession,
        'window.__e2e.done ? window.__e2e.results : null',
      );
      if (snapshot !== null) {
        results = snapshot;
        break;
      }
      await sleep(500);
    }
    if (results === null) throw new Error('the playground never finished its run');

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

    /*
     * The rule lifecycle, end to end in the real UI: create, rename, save,
     * duplicate, reorder, disable, delete, undo. Every one of these writes
     * through the worker and comes back as the thing the list renders, so a
     * break anywhere in that loop shows up here rather than in a bug report.
     */
    const lifecycle = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         /* Menu items are div[role=menuitem], not buttons: a helper that only
            looked at buttons silently found nothing and the menu steps looked
            broken when they were not. */
         const byText = (text) =>
           [...document.querySelectorAll('button, [role="menuitem"]')].find(
             (node) => node.textContent.trim() === text,
           );
         const type = (selector, text) => {
           const field = document.querySelector(selector);
           Object.getOwnPropertyDescriptor(
             window.HTMLInputElement.prototype,
             'value',
           ).set.call(field, text);
           field.dispatchEvent(new Event('input', { bubbles: true }));
         };
         const openMenu = async (name) => {
           const row = [...document.querySelectorAll('li button')].find((button) =>
             button.textContent.includes(name),
           );
           const trigger = row?.closest('li')?.querySelector('[aria-haspopup="menu"]');
           trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
           await pause(450);
           return trigger !== null && trigger !== undefined;
         };
         const choose = async (label) => {
           const item = byText(label);
           /* Radix commits a menu item on pointerup, and closes on the click
              that follows; a bare .click() lands on neither. */
           item?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
           item?.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }));
           item?.click();
           await pause(700);
           return item !== undefined;
         };
         const rules = async () => {
           const reply = await chrome.runtime.sendMessage({ type: 'config:get' });
           return reply?.config?.rules ?? [];
         };
         const names = async () => (await rules()).map((rule) => rule.name);
         const rowFor = (name) =>
           [...document.querySelectorAll('li button')].find((button) =>
             button.textContent.includes(name),
           );

         const before = (await rules()).length;

         /* Create. The new rule is selected and open, so it can be named at once. */
         byText('New rule')?.click();
         await pause(700);
         const created = (await rules()).length === before + 1;

         type('[aria-label="Rule name"]', 'Lifecycle rule');
         type('#decoy-url-value', '/api/lifecycle');
         await pause(250);
         byText('Save')?.click();
         await pause(700);
         const saved = (await names()).includes('Lifecycle rule');

         /* Duplicate, which lands directly below and starts disabled so it
            cannot surprise anyone. */
         const menuOpened = await openMenu('Lifecycle rule');
         const choseDuplicate = await choose('Duplicate');
         const afterDuplicate = await rules();
         const copyIndex = afterDuplicate.findIndex((rule) => rule.name.endsWith('(copy)'));
         const originalIndex = afterDuplicate.findIndex((rule) => rule.name === 'Lifecycle rule');
         const duplicated =
           copyIndex === originalIndex + 1 && afterDuplicate[copyIndex]?.enabled === false;

         /* Reorder: position is the entire priority model, so moving a rule to
            the top has to actually move it. */
         const copyName = afterDuplicate[copyIndex]?.name ?? '';
         await openMenu(copyName);
         await choose('Move to top');
         const movedToTop = (await rules())[0]?.name === copyName;

         /* The copy goes first, by the one part of its name the original does
            not share -- otherwise every later lookup finds the copy. */
         rowFor('(copy)')?.click();
         await pause(400);
         document.querySelector('[aria-label="Delete this rule"]')?.click();
         await pause(700);
         const copyGone = !(await names()).some((name) => name.endsWith('(copy)'));

         /* Disable from the list. The switch is labelled for what clicking it
            will do, which is why this looks for "Disable". */
         const toggle = [...document.querySelectorAll('[role="switch"]')].find((node) =>
           (node.getAttribute('aria-label') ?? '').startsWith('Disable Lifecycle rule'),
         );
         toggle?.click();
         await pause(700);
         const disabled =
           (await rules()).find((rule) => rule.name === 'Lifecycle rule')?.enabled === false;

         /* Delete, then take it back. The undo is the reason there is no
            confirm dialog on the common path. */
         rowFor('Lifecycle rule')?.click();
         await pause(400);
         document.querySelector('[aria-label="Delete this rule"]')?.click();
         await pause(600);
         const deleted = !(await names()).includes('Lifecycle rule');

         byText('Undo')?.click();
         await pause(700);
         const restored = (await names()).includes('Lifecycle rule');

         /* The master switch, which is what someone reaches for when they want
            their own app back for a minute. */
         const master = document.querySelector('[aria-label="Pause all mocking"]');
         master?.click();
         await pause(700);
         const pausedReply = await chrome.runtime.sendMessage({ type: 'config:get' });
         /* Case-insensitive: the status is an eyebrow, and innerText reports
            what is rendered -- which CSS has already put in capitals. */
         const saysPaused = /paused/i.test(document.body.innerText);
         const paused = pausedReply?.config?.enabled === false && saysPaused;

         /* Put everything back, so the shots and the next run start clean. */
         await chrome.storage.local.set({ ${JSON.stringify(STORAGE_KEY)}: ${JSON.stringify(SEED_CONFIG)} });
         await pause(500);

         return {
           created,
           saved,
           duplicated,
           copyGone,
           movedToTop,
           disabled,
           deleted,
           restored,
           paused,
         };
       })()`,
    );

    /*
     * Button state through a whole edit. The reported bug was that Save stayed
     * enabled after saving -- the form offering to save something it had just
     * saved -- and the same flaw meant a switch flipped in the list while the
     * form was open would be reverted by the next save. Both are asserted here
     * because both are invisible until someone loses work to them.
     */
    const buttonState = await evaluate(
      cdp,
      pageSession,
      `(async () => {
         const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const byText = (text) =>
           [...document.querySelectorAll('button')].find(
             (button) => button.textContent.trim() === text,
           );
         const state = () => ({
           save: byText('Save')?.disabled ?? null,
           discard: byText('Discard')?.disabled ?? null,
         });
         const type = (selector, text) => {
           const field = document.querySelector(selector);
           const proto =
             field instanceof HTMLTextAreaElement
               ? window.HTMLTextAreaElement.prototype
               : window.HTMLInputElement.prototype;
           Object.getOwnPropertyDescriptor(proto, 'value').set.call(field, text);
           field.dispatchEvent(new Event('input', { bubbles: true }));
         };

         const row = [...document.querySelectorAll('li button')].find((button) =>
           button.textContent.includes('Slow endpoint'),
         );
         row?.click();
         await pause(400);
         const atRest = state();

         type('[aria-label="Rule name"]', 'Slow endpoint edited');
         await pause(250);
         const dirty = state();

         byText('Save')?.click();
         await pause(700);
         const afterSave = state();

         type('[aria-label="Rule name"]', 'Slow endpoint edited twice');
         await pause(250);
         byText('Discard')?.click();
         await pause(300);
         const afterDiscard = {
           ...state(),
           name: document.querySelector('[aria-label="Rule name"]')?.value ?? '',
         };

         /* An invalid pattern must not be savable, however dirty the form is. */
         type('#decoy-url-value', '');
         await pause(250);
         const invalid = {
           ...state(),
           alert: document.querySelector('[role="alert"]')?.textContent ?? '',
         };
         byText('Discard')?.click();
         await pause(300);

         /* The switch belongs to the list, not to the form. Flipping it must
            not make the form dirty -- and must survive the next save. */
         const toggle = [...document.querySelectorAll('button[role="switch"]')].find((button) =>
           (button.getAttribute('aria-label') ?? '').includes('Slow endpoint'),
         );
         const toggled = toggle !== undefined;
         toggle?.click();
         await pause(600);
         const afterToggle = state();

         return { atRest, dirty, afterSave, afterDiscard, invalid, toggled, afterToggle };
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

         const code = document.querySelector('#decoy-handler-code');
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

         /*
          * The colours are a layer behind a transparent textarea, so they are
          * only ever as correct as their alignment. If the tokenizer drops or
          * duplicates a single character the whole file slides out from under
          * the caret -- invisible in code review, obvious and maddening in use.
          */
         const codeField = document.querySelector('#decoy-handler-code');
         const layer = codeField?.parentElement?.querySelector('pre[aria-hidden]');
         const aligned =
           layer !== null &&
           layer !== undefined &&
           layer.textContent.replace(/\u200b/g, '') === codeField.value;
         const coloured = new Set(
           [...(layer?.querySelectorAll('span') ?? [])]
             .map((span) => span.className)
             .filter((name) => name.length > 0),
         ).size;

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
           aligned,
           coloured,
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
      const host = document.querySelector('decoy-panel');
      if (host === null) return { mounted: false };
      const surface = host.shadowRoot?.querySelector('.decoy-surface') ?? null;
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
         const host = document.querySelector('decoy-panel');
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

         const surface = shadow.querySelector('.decoy-surface');
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

    /* Collapsing folds the panel away without losing it. */
    const panelCollapse = await evaluate(
      cdp,
      hostSession,
      `(async () => {
         const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
         const shadow = document.querySelector('decoy-panel')?.shadowRoot ?? null;
         if (shadow === null) return { reached: false };

         const surface = shadow.querySelector('.decoy-surface');
         const before = surface.getBoundingClientRect();

         const collapse = shadow.querySelector('[aria-label="Collapse the Decoy panel"]');
         if (collapse === null) return { reached: true, hasControl: false };
         collapse.click();
         await pause(400);

         const launcher = shadow.querySelector('[aria-label="Expand the Decoy panel"]');
         const collapsedState = {
           frameHidden: getComputedStyle(surface).display === 'none',
           launcherShown: launcher !== null,
           /* The launcher has to be reachable, not just present: a zero-sized
              or off-screen button is the same as no way back. */
           launcherOnScreen:
             launcher !== null &&
             launcher.getBoundingClientRect().width > 20 &&
             launcher.getBoundingClientRect().right <= window.innerWidth + 1,
         };

         launcher?.click();
         await pause(400);
         const after = surface.getBoundingClientRect();

         return {
           reached: true,
           hasControl: true,
           ...collapsedState,
           restored:
             getComputedStyle(surface).display !== 'none' &&
             Math.round(before.width) === Math.round(after.width) &&
             Math.round(before.x) === Math.round(after.x),
           /* Collapsing must not have thrown the UI away and rebuilt it. */
           keptContent: surface.innerText.includes('Decoy'),
         };
       })()`,
    );

    if (SCREENSHOT_DIR !== null && panel.mounted === true) {
      await mkdir(SCREENSHOT_DIR, { recursive: true });
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' }, hostSession);
      const file = path.join(SCREENSHOT_DIR, 'panel-over-page.png');
      await writeFile(file, Buffer.from(data, 'base64'));
      console.log(`screenshot: ${file}`);

      // And folded away, which is a state with its own failure mode: a
      // launcher nobody can find is the same as a panel nobody can reopen.
      const clickInPanel = (label) =>
        evaluate(
          cdp,
          hostSession,
          `(() => {
             document
               .querySelector('decoy-panel')
               ?.shadowRoot?.querySelector('[aria-label=' + JSON.stringify(${JSON.stringify(label)}) + ']')
               ?.click();
             return true;
           })()`,
        );

      await clickInPanel('Collapse the Decoy panel');
      await sleep(500);
      const collapsed = await cdp.send('Page.captureScreenshot', { format: 'png' }, hostSession);
      const collapsedFile = path.join(SCREENSHOT_DIR, 'panel-collapsed.png');
      await writeFile(collapsedFile, Buffer.from(collapsed.data, 'base64'));
      console.log(`screenshot: ${collapsedFile}`);

      await clickInPanel('Expand the Decoy panel');
      await sleep(400);
    }

    // Injecting a second time is how the panel is dismissed.
    await evaluate(
      cdp,
      pageSession,
      `chrome.runtime.sendMessage({ type: 'panel:toggle', tabId: ${String(panelTabId)} })`,
    );
    await sleep(900);
    const afterToggle = await evaluate(cdp, hostSession, inspectPanel);

    /*
     * Agent control, against the real bridge.
     *
     * The unit tests prove the protocol; none of them proves the service worker
     * actually dials out, which is the half that can silently stop working. So
     * this starts the bridge an MCP server starts, writes the settings the UI
     * writes, and then asks the browser to do real work through it.
     */
    const agent = await checkAgentBridge(cdp, workerSession);

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
      ["ui: the handler editor shows the rule's code", handlerEditor.showsCode === true],
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
      [
        'ui: a rule with no edits cannot be saved or discarded',
        buttonState.atRest.save === true && buttonState.atRest.discard === true,
      ],
      [
        'ui: editing enables both',
        buttonState.dirty.save === false && buttonState.dirty.discard === false,
      ],
      [
        'ui: saving disables them again',
        buttonState.afterSave.save === true && buttonState.afterSave.discard === true,
      ],
      [
        'ui: discarding reverts the field and disables them again',
        buttonState.afterDiscard.save === true &&
          buttonState.afterDiscard.discard === true &&
          buttonState.afterDiscard.name === 'Slow endpoint edited',
      ],
      [
        'ui: an invalid url pattern cannot be saved, and says why',
        buttonState.invalid.save === true &&
          buttonState.invalid.discard === false &&
          buttonState.invalid.alert.includes('required'),
      ],
      [
        'ui: the list switch does not make the open form dirty',
        buttonState.toggled === true && buttonState.afterToggle.save === true,
      ],
      [
        'ui: the highlight layer matches the code character for character',
        handlerEditor.aligned === true,
      ],
      [
        `ui: the handler is actually coloured (${String(handlerEditor.coloured)} kinds)`,
        typeof handlerEditor.coloured === 'number' && handlerEditor.coloured >= 4,
      ],
      ['ui: New rule creates one and opens it', lifecycle.created === true],
      ['ui: a named, patterned rule saves', lifecycle.saved === true],
      [
        'ui: duplicating lands below the original and starts disabled',
        lifecycle.duplicated === true,
      ],
      [
        'ui: move to top actually reorders, which is the priority model',
        lifecycle.movedToTop === true,
      ],
      ['ui: deleting the duplicate leaves the original alone', lifecycle.copyGone === true],
      ['ui: the list switch disables a rule', lifecycle.disabled === true],
      [
        'ui: deleting removes it, and undo brings it back',
        lifecycle.deleted === true && lifecycle.restored === true,
      ],
      ['ui: the master switch pauses everything and says so', lifecycle.paused === true],
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
        typeof panel.text === 'string' && panel.text.includes('Decoy'),
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
      [
        'panel: collapses to a launcher at the edge of the page',
        panelCollapse.frameHidden === true && panelCollapse.launcherShown === true,
      ],
      ['panel: the launcher is actually reachable', panelCollapse.launcherOnScreen === true],
      [
        'panel: expanding restores the same panel, not a new one',
        panelCollapse.restored === true && panelCollapse.keptContent === true,
      ],
      ['panel: a second toggle takes it away again', afterToggle.mounted === false],

      ['agent: the worker connects out to the bridge', agent.connected],
      [
        `agent: status comes back over the socket (${String(agent.status?.rules ?? 0)} rules)`,
        agent.status?.mocking === true && (agent.status?.rules ?? 0) > 0,
      ],
      ['agent: a rule an agent wrote lands at the top, where it wins', agent.created],
      ['agent: it is in the real config, validated like any other write', agent.storedInConfig],
      [`agent: the page sees it immediately (${String(agent.answered)})`, agent.answered === 418],
      ['agent: which-rule-wins names the rule that answered', agent.winsNamed],
      ['agent: an update keeps the fields it did not mention', agent.updateKeptUrl],
      ['agent: the traffic log is readable over the bridge', agent.sawTraffic],
      ['agent: deleting it lets the page reach the network again', agent.deleted],
      ['agent: a command for a rule that is gone is refused, not ignored', agent.refusedMissing],
      ['agent: a bridge with the wrong token never gets a browser', agent.refusedBadToken],
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
    for (const server of servers) server.close();
    await session.close();
  }

  process.exit(failures === 0 ? 0 : 1);
}

await main();
