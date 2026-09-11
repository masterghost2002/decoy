/**
 * The playground UI.
 *
 * Plain DOM on purpose. This page is the thing you open when the extension is
 * behaving oddly, and a build step between you and it -- or a framework whose
 * own fetch you then have to reason about -- would be exactly the wrong kind of
 * complexity in that moment. Nothing here calls fetch except the cases.
 */
import {
  allCases,
  liveStatus,
  onLiveStatus,
  runAll,
  runCase,
  suites,
  summarize,
} from './harness.js';
import { buildRules, STORAGE_KEY } from './rules.mjs';

// Importing a suite registers it. Order here is the order on the page, and
// wiring comes first because when it fails everything below it is a symptom.
import './suites/wiring.js';
import './suites/matching.js';
import './suites/respond.js';
import './suites/conditions.js';
import './suites/stream.js';
import './suites/failures.js';
import './suites/handlers.js';
import './suites/fetch-api.js';
import './suites/xhr-api.js';
import './suites/limits.js';

const deployment = window.__decoyPlayground ?? {};

/* -------------------------------------------------------------------------- */
/* Small DOM helpers                                                          */
/* -------------------------------------------------------------------------- */

const $ = (selector) => document.querySelector(selector);

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  for (const child of [children].flat()) {
    if (child === null || child === undefined) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

/* -------------------------------------------------------------------------- */
/* Live status                                                                */
/* -------------------------------------------------------------------------- */

const expectedRules = buildRules({
  port: Number(deployment.port ?? location.port ?? 0),
  altPort: Number(deployment.altPort ?? 0),
});
let live = liveStatus();

function paintStatus() {
  const dot = $('#status .status-dot');
  const text = $('#status .status-text');
  if (!live.detected) {
    dot.dataset.state = 'missing';
    text.textContent = 'extension not detected on this page';
    return;
  }
  const seeded = expectedRules.filter((rule) => live.seeded.has(rule.id)).length;
  dot.dataset.state = live.enabled ? 'live' : 'paused';
  text.textContent = `${live.enabled ? 'intercepting' : 'paused'} · ${String(seeded)}/${String(expectedRules.length)} playground rules · ${String(live.ruleCount)} total`;
}

/* -------------------------------------------------------------------------- */
/* The case list                                                              */
/* -------------------------------------------------------------------------- */

/** Every rendered row, by case id, so a result only repaints its own row. */
const rows = new Map();
const results = new Map();

function buildList() {
  const container = $('#suites');
  container.textContent = '';

  for (const entry of suites) {
    const list = el('ul', { class: 'cases' });
    for (const testCase of entry.cases) {
      const detail = el('span', { class: 'detail', text: 'not run yet' });
      const ms = el('span', { class: 'ms', text: '' });
      const run = el('button', { class: 'tiny', type: 'button', text: 'Run' });
      run.addEventListener('click', () => {
        void runOne(testCase);
      });

      const chips = el('div', { class: 'rule-chips' });
      const more = el('details', { class: 'case-more' }, [
        el('summary', { text: 'why this case exists' }),
        testCase.doc.length > 0 ? el('p', { class: 'doc', text: testCase.doc }) : null,
        chips,
      ]);

      const row = el('li', { class: 'case', 'data-status': 'idle', 'data-case': testCase.id }, [
        el('div', { class: 'case-row' }, [
          el('span', { class: 'dot' }),
          el('span', { class: 'case-name' }, [
            el('span', { class: 'title', text: testCase.shortName }),
            detail,
          ]),
          ms,
          run,
        ]),
        more,
      ]);

      rows.set(testCase.id, { row, detail, ms, chips, testCase });
      list.append(row);
    }

    container.append(
      el('section', { class: 'suite', 'data-suite': entry.id }, [
        el('div', { class: 'suite-head' }, [
          el('h2', { text: entry.title }),
          el('span', { class: 'blurb', text: entry.blurb }),
          el('span', { class: 'count', text: `${String(entry.cases.length)} cases` }),
        ]),
        list,
      ]),
    );
  }
  paintChips();
}

/** Rule chips carry whether that rule is actually seeded right now. */
function paintChips() {
  for (const { chips, testCase } of rows.values()) {
    const wanted = testCase.rules;
    const rendered = chips.dataset.state;
    const state = `${wanted.join(',')}|${String(live.detected)}|${wanted.filter((id) => live.seeded.has(id)).join(',')}`;
    if (rendered === state) continue;
    chips.dataset.state = state;
    chips.textContent = '';
    if (wanted.length === 0) {
      chips.append(el('span', { class: 'chip', text: 'needs no rule' }));
      continue;
    }
    for (const id of wanted) {
      const seeded = live.detected && live.seeded.has(id);
      chips.append(el('span', { class: 'chip', 'data-seeded': seeded ? 'yes' : 'no', text: id }));
    }
  }
}

function paintResult(result) {
  const entry = rows.get(result.id);
  if (entry === undefined) return;
  results.set(result.id, result);
  entry.row.dataset.status = result.status;
  entry.detail.textContent = result.detail;
  entry.ms.textContent = result.status === 'skip' ? '' : `${String(result.ms)}ms`;
  applyFilter();
}

function markRunning(testCase) {
  const entry = rows.get(testCase.id);
  if (entry === undefined) return;
  entry.row.dataset.status = 'running';
  entry.detail.textContent = 'running…';
}

/* -------------------------------------------------------------------------- */
/* Filtering                                                                  */
/* -------------------------------------------------------------------------- */

function matchesFilter(testCase) {
  const needle = $('#filter').value.trim().toLowerCase();
  if (needle.length > 0) {
    /* Name and rule ids only, deliberately not the explanatory prose: typing
       "match" should show the matching suite, not every case whose paragraph
       happens to use the word. */
    const haystack = `${testCase.name} ${testCase.rules.join(' ')}`.toLowerCase();
    if (!haystack.includes(needle)) return false;
  }
  if ($('#skip-slow').checked && testCase.slow) return false;
  return true;
}

function applyFilter() {
  const hidePassing = $('#hide-passing').checked;
  for (const [id, entry] of rows) {
    const result = results.get(id);
    const hidden = !matchesFilter(entry.testCase) || (hidePassing && result?.status === 'pass');
    entry.row.hidden = hidden;
  }
  for (const section of document.querySelectorAll('.suite')) {
    const visible = [...section.querySelectorAll('li.case')].some((row) => !row.hidden);
    section.hidden = !visible;
  }
}

/* -------------------------------------------------------------------------- */
/* Running                                                                    */
/* -------------------------------------------------------------------------- */

let running = false;
let stopRequested = false;

function setRunning(value) {
  running = value;
  $('#run-all').disabled = value;
  $('#run-failed').disabled = value || [...results.values()].every((result) => result.ok);
  $('#stop').disabled = !value;
}

function paintSummary(partial) {
  const all = [...results.values()];
  const totals = summarize(all);
  $('#summary [data-kind="pass"]').textContent = `${String(totals.passed)} passed`;
  $('#summary [data-kind="fail"]').textContent = `${String(totals.failed)} failed`;
  $('#summary [data-kind="skip"]').textContent = `${String(totals.skipped)} skipped`;
  $('#summary [data-kind="time"]').textContent =
    totals.total === 0 ? '—' : `${(totals.ms / 1000).toFixed(1)}s of request time`;
  $('#progress').textContent = partial ?? '';
}

async function runOne(testCase) {
  if (running) return;
  setRunning(true);
  markRunning(testCase);
  paintResult(await runCase(testCase));
  paintSummary('');
  setRunning(false);
}

async function runMany(only) {
  if (running) return;
  setRunning(true);
  stopRequested = false;

  const planned = allCases().filter(only);
  const plannedIds = new Set(planned.map((testCase) => testCase.id));
  for (const testCase of planned) results.delete(testCase.id);
  paintSummary(`0 / ${String(planned.length)}`);

  let done = 0;
  await runAll({
    only: (testCase) => !stopRequested && plannedIds.has(testCase.id),
    onStart: markRunning,
    onResult: (result) => {
      done += 1;
      paintResult(result);
      paintSummary(`${String(done)} / ${String(planned.length)}`);
    },
  });

  paintSummary(stopRequested ? 'stopped' : 'done');
  setRunning(false);
}

/* -------------------------------------------------------------------------- */
/* The rule set panel                                                         */
/* -------------------------------------------------------------------------- */

function describeAction(action) {
  switch (action.kind) {
    case 'respond':
      return `respond ${String(action.status)}${action.delayMs > 0 ? ` after ${String(action.delayMs)}ms` : ''}`;
    case 'stream':
      return `stream ${action.format} · ${String(action.chunks.length)} chunks · every ${String(action.intervalMs)}ms · ${action.repeat === 0 ? 'endless' : `${String(action.repeat)}×`}`;
    case 'handler':
      return `handler · ${String(action.code.split('\n').length)} lines`;
    case 'networkError':
      return `fail ${action.errorType}`;
    case 'passthrough':
      return 'pass through';
    default:
      return action.kind;
  }
}

function describeMatcher(matcher) {
  const methods = matcher.methods.length === 0 ? '*' : matcher.methods.join(',');
  const conditions =
    matcher.conditions.length === 0
      ? ''
      : ` · ${matcher.conditionMode} of ${String(matcher.conditions.length)}`;
  return `${methods} · ${matcher.url.mode} ${matcher.url.value}${conditions}`;
}

function paintRules() {
  const diff = $('#rules-diff');
  const missing = expectedRules.filter((rule) => !live.seeded.has(rule.id));
  diff.textContent = '';

  if (!live.detected) {
    diff.append(
      el('div', { class: 'note', 'data-tone': 'bad' }, [
        'No config has reached this page, so Decoy is either not installed, not enabled for this origin, or was reloaded after this page was. Reload the page after loading the extension.',
      ]),
    );
  } else if (missing.length > 0) {
    diff.append(
      el('div', { class: 'note', 'data-tone': 'bad' }, [
        `${String(missing.length)} of ${String(expectedRules.length)} rules are not seeded, so the cases that need them will skip. Run `,
        el('code', { text: 'pnpm playground' }),
        ', or paste the snippet above into the extension page console.',
      ]),
    );
  } else {
    diff.append(
      el('div', { class: 'note' }, [
        `All ${String(expectedRules.length)} rules are seeded. Extra rules of your own are fine — they only matter if one of them matches a playground url first.`,
      ]),
    );
  }

  const table = el('table', { class: 'rules' }, [
    el('thead', {}, [
      el('tr', {}, [
        el('th', { text: '#' }),
        el('th', { text: 'id' }),
        el('th', { text: 'name' }),
        el('th', { text: 'matches' }),
        el('th', { text: 'then' }),
        el('th', { text: 'seeded' }),
      ]),
    ]),
    el(
      'tbody',
      {},
      expectedRules.map((rule, index) =>
        el('tr', {}, [
          el('td', { class: 'mono', text: String(index + 1).padStart(3, '0') }),
          el('td', { class: 'mono', text: rule.id }),
          el('td', { text: rule.name }),
          el('td', { class: 'mono', text: describeMatcher(rule.matcher) }),
          el('td', { class: 'mono', text: describeAction(rule.action) }),
          el('td', {}, [
            el('span', {
              class: 'pill',
              text: !live.detected ? '—' : live.seeded.has(rule.id) ? 'yes' : 'no',
            }),
          ]),
        ]),
      ),
    ),
  ]);

  $('#rules-list').textContent = '';
  $('#rules-list').append(table);
}

function seedingSnippet() {
  const config = { version: 1, enabled: true, rules: expectedRules };
  return `chrome.storage.local.set(${JSON.stringify({ [STORAGE_KEY]: config })})`;
}

async function copyText(text, note) {
  try {
    await navigator.clipboard.writeText(text);
    $('#copy-note').textContent =
      `${note} — ${String(Math.round(text.length / 1024))} kB on the clipboard`;
  } catch {
    $('#copy-note').textContent = 'the clipboard refused; select the table below instead';
  }
}

/* -------------------------------------------------------------------------- */
/* The request bench                                                          */
/* -------------------------------------------------------------------------- */

function parseHeaderLines(text) {
  const headers = {};
  for (const line of text.split('\n')) {
    const separator = line.indexOf(':');
    if (separator === -1) continue;
    const name = line.slice(0, separator).trim();
    if (name.length === 0) continue;
    headers[name] = line.slice(separator + 1).trim();
  }
  return headers;
}

async function sendBenchRequest() {
  const method = $('#bench-method').value;
  const url = $('#bench-url').value;
  const transport = $('#bench-transport').value;
  const headers = parseHeaderLines($('#bench-headers').value);
  const rawBody = $('#bench-body').value;
  const body = rawBody.length === 0 || method === 'GET' || method === 'HEAD' ? undefined : rawBody;

  const startedAt = performance.now();
  try {
    if (transport === 'fetch') {
      const response = await fetch(url, { method, headers, body });
      const text = await response.text();
      return {
        ok: true,
        head: `${String(response.status)} ${response.statusText} · ${String(Math.round(performance.now() - startedAt))}ms`,
        headers: [...response.headers.entries()]
          .map(([name, value]) => `${name}: ${value}`)
          .join('\n'),
        body: text,
      };
    }

    const xhr = new XMLHttpRequest();
    xhr.open(method, url, transport === 'xhr');
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    if (transport === 'xhr') {
      await new Promise((resolve) => {
        for (const type of ['load', 'error', 'timeout', 'abort']) {
          xhr.addEventListener(type, resolve, { once: true });
        }
        xhr.send(body ?? null);
      });
    } else {
      xhr.send(body ?? null);
    }
    return {
      ok: true,
      head: `${String(xhr.status)} ${xhr.statusText} · ${String(Math.round(performance.now() - startedAt))}ms`,
      // getAllResponseHeaders is CRLF-separated; a stray CR renders as a box.
      headers: xhr.getAllResponseHeaders().replace(/\r\n/g, '\n').trim(),
      body: xhr.responseText,
    };
  } catch (error) {
    return {
      ok: false,
      head: `rejected after ${String(Math.round(performance.now() - startedAt))}ms`,
      headers: '',
      body: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  }
}

function paintBench(result) {
  const out = $('#bench-out');
  out.textContent = '';
  out.append(el('div', { class: 'head', text: result.head }));
  if (result.headers.length > 0) out.append(el('div', { text: `\n${result.headers}` }));
  out.append(el('div', { text: `\n${result.body.slice(0, 8000)}` }));
}

/* -------------------------------------------------------------------------- */
/* Traffic generators                                                         */
/* -------------------------------------------------------------------------- */

const GENERATORS = [
  {
    title: 'One of each outcome',
    blurb: 'A mocked call, a passthrough and a failure, so the traffic log shows all three.',
    async run(log) {
      await fetch('/pg/plain');
      await fetch('/api/ping');
      await fetch('/pg/fail/failed').catch(() => {});
      log('three requests, three outcomes');
    },
  },
  {
    title: 'A burst of 120',
    blurb: 'Enough to exercise the content bridge batching the traffic it reports.',
    async run(log) {
      const startedAt = performance.now();
      await Promise.all(
        Array.from({ length: 120 }, (_, index) => fetch(`/pg/plain?burst=${String(index)}`)),
      );
      log(`120 requests in ${String(Math.round(performance.now() - startedAt))}ms`);
    },
  },
  {
    title: 'A trickle, one a second',
    blurb: 'Ten requests over ten seconds, for watching the fired stamps decay.',
    async run(log) {
      for (let index = 0; index < 10; index += 1) {
        await fetch(`/pg/echo?trickle=${String(index)}`);
        log(`${String(index + 1)} of 10`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    },
  },
  {
    title: 'A payload past the capture cap',
    blurb: 'A 100 kB upload. The drawer shows the first 64 kB and says it was truncated.',
    async run(log) {
      await fetch('/real/big-upload', { method: 'POST', body: 'x'.repeat(100 * 1024) });
      log('100 kB sent — check the request body in the traffic drawer');
    },
  },
  {
    title: 'Every status class',
    blurb: 'One request per status, so the status pills can be reviewed side by side.',
    async run(log) {
      for (const status of [200, 201, 204, 301, 400, 401, 403, 404, 418, 429, 500, 503]) {
        await fetch(`/pg/respond/status/${String(status)}`);
      }
      log('twelve statuses logged');
    },
  },
  {
    title: 'A long-running stream',
    blurb: 'An endless event source, left open for fifteen seconds.',
    async run(log) {
      const controller = new AbortController();
      const response = await fetch('/pg/stream/endless', { signal: controller.signal });
      const reader = response.body.getReader();
      const until = Date.now() + 15000;
      let chunks = 0;
      while (Date.now() < until) {
        const next = await reader.read();
        if (next.done) break;
        chunks += 1;
        if (chunks % 10 === 0) log(`${String(chunks)} chunks so far`);
      }
      controller.abort();
      log(`${String(chunks)} chunks, then aborted`);
    },
  },
];

function buildGenerators() {
  const container = $('#generators');
  const logNode = $('#generate-log');
  const log = (line) => {
    logNode.textContent = `${line}\n${logNode.textContent}`.slice(0, 4000);
  };

  for (const generator of GENERATORS) {
    const button = el('button', { type: 'button', class: 'primary', text: 'Run' });
    button.addEventListener('click', () => {
      button.disabled = true;
      log(`— ${generator.title}`);
      void generator
        .run(log)
        .catch((error) => log(`failed: ${String(error)}`))
        .finally(() => {
          button.disabled = false;
        });
    });
    container.append(
      el('div', { class: 'card' }, [
        el('h3', { text: generator.title }),
        el('p', { text: generator.blurb }),
        button,
      ]),
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Wiring it all up                                                           */
/* -------------------------------------------------------------------------- */

function selectTab(name) {
  for (const button of document.querySelectorAll('.tabs button')) {
    button.setAttribute('aria-selected', String(button.dataset.tab === name));
  }
  for (const panel of document.querySelectorAll('.panel')) {
    panel.hidden = panel.dataset.panel !== name;
  }
}

buildList();
buildGenerators();
paintSummary('');
setRunning(false);

/* Subscribed after the list exists, not at the top of the file: onLiveStatus
   calls its listener immediately with whatever is already known, and painting
   into a list that has not been built yet is a temporal-dead-zone crash that
   takes the whole module down. */
onLiveStatus((next) => {
  live = next;
  paintStatus();
  paintRules();
  paintChips();
});

for (const button of document.querySelectorAll('.tabs button')) {
  button.addEventListener('click', () => selectTab(button.dataset.tab));
}

$('#run-all').addEventListener('click', () => {
  void runMany(matchesFilter);
});
$('#run-failed').addEventListener('click', () => {
  void runMany((testCase) => results.get(testCase.id)?.ok === false);
});
$('#stop').addEventListener('click', () => {
  stopRequested = true;
});
$('#filter').addEventListener('input', applyFilter);
$('#hide-passing').addEventListener('change', applyFilter);
$('#skip-slow').addEventListener('change', applyFilter);
$('#copy-rules').addEventListener('click', () => {
  void copyText(seedingSnippet(), 'paste this into the extension page console');
});
$('#copy-json').addEventListener('click', () => {
  void copyText(JSON.stringify(expectedRules, null, 2), 'the rules as json');
});
$('#bench').addEventListener('submit', (event) => {
  event.preventDefault();
  void sendBenchRequest().then(paintBench);
});
$('#bench-repeat').addEventListener('click', () => {
  void (async () => {
    let last = null;
    for (let index = 0; index < 10; index += 1) last = await sendBenchRequest();
    paintBench({ ...last, head: `ten sent · last: ${last.head}` });
  })();
});

document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
    if (event.key === 'Escape') event.target.blur();
    return;
  }
  if (event.key === '/') {
    event.preventDefault();
    $('#filter').focus();
  }
  if (event.key === 'r' && !event.metaKey && !event.ctrlKey) {
    void runMany(matchesFilter);
  }
});

/*
 * The contract the e2e runner drives. Same entry point as the Run all button,
 * so there is only ever one definition of what passing means.
 */
window.__decoy = {
  runAll: (options) => runAll(options),
  runCase: (id) => {
    const found = allCases().find((testCase) => testCase.id === id || testCase.name === id);
    return found === undefined ? Promise.resolve(null) : runCase(found);
  },
  cases: allCases().map((testCase) => testCase.name),
  status: () => {
    const current = liveStatus();
    return {
      detected: current.detected,
      enabled: current.enabled,
      ruleCount: current.ruleCount,
      expected: expectedRules.length,
      missing: expectedRules.filter((rule) => !current.seeded.has(rule.id)).map((rule) => rule.id),
    };
  },
};
