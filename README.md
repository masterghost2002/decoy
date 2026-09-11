# Mocksmith

Mock any browser request without touching your code.

Front-end work stalls in two places: waiting for an endpoint that is not deployed yet, and
reproducing the failure cases — a 404, a 500, a 30-second response, a dropped connection. Today
that usually means editing the app to throw on purpose, then remembering to take it out again.
Mocksmith moves that into the browser, where it belongs: match a request by url, answer it with
whatever status, body, headers or failure you want, and flip it off when you are done.

**Status: slice 1.** `fetch` and `XMLHttpRequest` are fully intercepted and verified end to end.
The layers for static resources, WebSockets, scenario sharing and MCP control are designed for but
not built — see [Roadmap](#roadmap).

## Quick start

```bash
pnpm install
pnpm --filter @mocksmith/extension build
```

Then in Chrome: `chrome://extensions` → enable **Developer mode** → **Load unpacked** →
select `apps/extension/dist`.

Click the toolbar icon for the popup, or the ↗ button in the popup for the full-page view.
During development, `pnpm dev` rebuilds on save; press reload on the extensions page to pick the
change up.

## How it works

Mocking every kind of browser request needs more than one mechanism, and the mechanisms have
genuinely different capabilities. Rather than pretend otherwise, Mocksmith layers them:

| Layer | Covers | Can synthesize a status + body? |
| --- | --- | --- |
| **1. Page-world patch** (built) | `fetch`, `XMLHttpRequest` | Yes — full control |
| 2. `declarativeNetRequest` (planned) | images, media, css, fonts, documents | No — block, redirect and header rewrite only |
| 3. `chrome.debugger` (planned, opt-in) | everything, at full fidelity | Yes, but shows a debugging banner and cannot attach while DevTools is open |

Layer 1 covers the overwhelming majority of front-end debugging and costs nothing: no warning
banner, and it works with DevTools open. That is why it came first.

### Request path

```
                 ┌──────────────────────── page (MAIN world) ────────────────────────┐
                 │  injected.js at document_start                                    │
  page code ───► │  patched fetch / XMLHttpRequest ──► @mocksmith/core matcher        │
                 │        │                                    │                     │
                 │        │ no rule matched                     │ rule matched        │
                 │        ▼                                    ▼                     │
                 │  native fetch / XHR                  synthesized response         │
                 └────────────┬──────────────────────────────────┬───────────────────┘
                              │ postMessage (traffic)            │ postMessage (config)
                 ┌────────────▼──────────── bridge.js (isolated world) ──────────────┐
                 │  batches traffic, relays config                                   │
                 └────────────┬──────────────────────────────────▲───────────────────┘
                              │ chrome.runtime                   │
                 ┌────────────▼──────────────────────────────────┴───────────────────┐
                 │  background.js — validates, persists, fans out, keeps traffic log │
                 └───────────────────────────────────────────────────────────────────┘
```

Matching happens **in the page**, not in the service worker. A round trip per request would add
latency to every call and would break whenever MV3 put the worker to sleep. The worker owns the
rules; the page owns the decision.

### Why the packages are split this way

- **`packages/core`** — the matcher, the rule contract and the response planner. Pure TypeScript,
  no DOM and no `chrome.*`. Its main entry deliberately contains **no zod**, because that entry is
  bundled into every page; validation lives behind `@mocksmith/core/schema` and is used only by
  the service worker and the UI. The injected bundle is 12 kB minified as a result.
- **`apps/extension`** — the MV3 surfaces: service worker, content bridge, injected script, and a
  React 19 + Vite + Tailwind 4 + shadcn UI shared by the popup and the full tab.

The service worker builds as three separate single-file IIFE bundles, because Chrome loads them
without a module loader and the injected script has to run at `document_start`.

## The rule model

A rule is a matcher plus an action. Rules are evaluated top to bottom and **the first enabled match
wins** — that is the entire priority model. No scores, no specificity heuristics; if you want a rule
to win, move it up.

```
match:  url (contains | equals | startsWith | endsWith | wildcard | regex)
        methods (any, or a specific set)

then:   respond       status 200-599, headers, json/text/empty body, delay
        fail          failed (TypeError) | timeout (hangs) | aborted (AbortError), delay
        pass through   let this one reach the real network
```

`pass through` exists so you can carve an exception out of a broad rule: put
`/api/users/me → pass through` above `/api/users → 404` and only the narrow one stays real.

Some deliberate decisions worth knowing:

- **Bodies are stored as raw strings and never reformatted.** Invalid JSON is a legitimate thing to
  mock, so the editor warns about it and sends it anyway.
- **Delays interact with client timeouts properly.** A mocked XHR never touches the network, so its
  native `timeout` would never fire; Mocksmith emulates it. Set `xhr.timeout = 300` against a
  1500 ms mock and you get a real `timeout` event.
- **`responseText` throws for binary response types**, exactly as the platform does. A mock that is
  more forgiving than the network hides bugs instead of finding them.
- **Every request is logged, not just the mocked ones.** "My rule didn't fire and I can't see why"
  is the fastest way for a tool like this to waste an afternoon, so the traffic panel shows
  passthrough, mocked and failed requests alike, and the rule editor has a *Test a url* box that
  answers match/no-match against the pattern you are editing.
- **Aborted and timed-out requests are logged too**, since those are usually the ones you are
  chasing.

## Testing

```bash
pnpm typecheck                              # every package
pnpm test                                   # 62 unit tests
pnpm --filter @mocksmith/extension e2e      # 20 end-to-end checks in a real Chrome
```

The unit tests cover the matcher, the response planner, config validation and the editor's rule
transforms. The E2E run is the one that matters for the interceptor: it launches a real Chrome with
the built extension loaded, seeds a rule set through `chrome.storage.local`, serves a fixture page
over http, and asserts real behaviour from inside that page — status and header synthesis, rule
ordering, delays, aborts mid-delay, hung requests, 204 body handling, the full XHR `readyState`
lifecycle, handlers attached after `send()`, `responseType` variants, emulated client timeouts,
instance reuse, and passthrough. It then loads the extension's own UI and checks that the rules and
the traffic those scenarios produced both render.

> **E2E needs a Chrome for Testing build.** Chrome 137+ ignores `--load-extension` on the stable
> channel, so an installed Chrome cannot load an unpacked extension from the command line. The
> script finds a build already cached by Playwright or Puppeteer; otherwise run
> `npx playwright install chromium`, or set `CHROME_PATH`.
>
> `E2E_HEADED=1` watches it happen. `E2E_SCREENSHOT_DIR=./shots` writes PNGs of each UI surface.

`fixtures/index.html` is also a manual harness: serve it, load the extension, click **Run checks**.

## Known limits

Honest list, so nobody debugs a limitation as if it were a bug:

- Only `fetch` and `XMLHttpRequest` are intercepted. Images, media, stylesheets, documents,
  WebSockets and `EventSource` reach the network untouched.
- Requests made by a page's own service worker or in a dedicated worker are not intercepted; the
  patch is installed in the page's main world only.
- A 1xx status cannot be mocked. The Fetch spec refuses to construct such a `Response`, and it is
  not observable to `fetch` or XHR anyway, so the rule schema stops at 200.
- `Set-Cookie` on a mocked response is dropped by the platform's own header guard, and would not
  set a cookie regardless.
- The traffic log lives in the service worker's memory. MV3 may terminate the worker, which clears
  it; the rules themselves are persisted.
- Requests made in the first few milliseconds of a page load wait up to 1 s for rules to arrive,
  then pass through rather than stall the page. A truly synchronous XHR cannot wait at all and
  decides with whatever rules are already known.
- The rule editor saves explicitly. Toggles apply immediately, but a half-typed url pattern should
  not hijack traffic, so edits need **Save**.
- Themes follow the OS. There is no in-app light/dark toggle yet.

### Security notes

`window.postMessage` is the only channel between the page world and an isolated content script, so
a host page can observe the config pushed to it and the traffic reported back. The page already
made every request being reported, and a forged config message could only change how that page's
own requests are answered — no cross-origin reach and no extension privilege. It is worth knowing
before you enable Mocksmith on a page you do not trust.

The extension asks for `storage` plus `<all_urls>` host access, and nothing else. `<all_urls>` is
inherent: a tool that mocks any request has to be able to run on any page.

## Roadmap

Ordered by how much each unblocks:

1. **Scenarios** — named sets of rule overrides, one active at a time, so "logged out", "empty
   state" and "server on fire" become one click each instead of six toggles.
2. **Record then replay** — capture a real response once and turn it into a mock, which is the
   direct answer to "the backend is not deployed yet".
3. **WebSocket and SSE mocking** — a scriptable virtual server: message timelines, pattern-matched
   replies, close codes, reconnect storms. The page-world patch is the only mechanism that can
   inject frames, so this builds on layer 1.
4. **Layer 2 (`declarativeNetRequest`)** — block, redirect and rewrite headers for images, media,
   fonts, css and documents.
5. **Import** — Postman collections, OpenAPI specs and HAR files into rules, with AI-generated
   example bodies.
6. **Sharing** — export/import a config file first, then a small service so a team shares scenario
   sets instead of screenshotting them.
7. **MCP server** — a local server bridged to the extension so Claude and other agents can list,
   add and activate rules, and read the traffic log, while driving a browser.
8. **Layer 3 (`chrome.debugger`)** — opt-in deep mode for true status + body control over any
   resource type, with a clear fallback when DevTools is already attached.
