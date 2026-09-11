# The Decoy playground

A page that exercises every request shape Decoy can answer, against a real server, with the real
extension loaded. It is the behavioural test suite and a hands-on harness at the same time — the
cases you click through when something looks wrong are exactly the ones CI runs, so there is only
ever one definition of working.

```bash
pnpm --filter @mocksmith/extension build
pnpm playground                             # opens it, with the rule set already seeded
pnpm --filter @mocksmith/extension e2e      # runs the same cases headless, and asserts
```

`pnpm playground` launches a Chrome for Testing with the built extension, seeds the rules through
`chrome.storage.local`, serves this directory, and opens two tabs: the playground and Decoy's own
workspace. Change a rule in one, watch it take effect in the other.

Without a Chrome for Testing build the launcher still serves the page and tells you how to seed a
Chrome you already have: load `apps/extension/dist` unpacked, open the **Rule set** tab, press
**Copy the seeding snippet**, and paste it into the extension page's DevTools console.

## What is here

| File | What it is |
| --- | --- |
| `rules.mjs` | the rule set, as data. Loaded by the launcher, by `e2e.mjs` and by the page itself |
| `server.mjs` | the fixture server — what a request reaches when no rule takes it |
| `harness.js` | the registry, the runner and the assertions |
| `suites/*.js` | the cases, one file per area |
| `app.js` | the page: the list, the filter, the rule table, the request bench, the generators |
| `assets/` | a worker and an iframe, for the two cases that need their own context |

No build step and no framework, on purpose. This is what you open when the extension is behaving
oddly, and a bundler — or a framework with its own `fetch` to reason about — would be the wrong
complexity in that moment. Nothing here calls `fetch` except the cases themselves.

## Writing a case

```js
import { assert, assertEqual, suite } from '../harness.js';

const add = suite('respond', 'Respond', 'A status, headers and a body, synthesized in the page.');

add('a delay is honoured before the response arrives', {
  rules: ['pg_respond_delay'],     // skipped, not failed, if these are not seeded
  slow: true,                      // hidden by "Skip timing cases"
  doc: 'Why this case exists, in a sentence. Shown under the row.',
  async run() {
    const response = await fetch('/pg/respond/delay');
    assertEqual(response.status, 200, 'status');
    return 'what actually happened, for the row';   // the detail line
  },
});
```

Three rules hold for every case, and they are what make the list worth trusting:

1. **Independent and re-runnable.** Key anything stateful by `nonce()`, and undo anything global —
   `setCookie` hands back its own cleanup. Clicking a case twice must give the same answer, and so
   must running the list in any order. A case that never settles is cut off after 15 s rather than
   taking the run with it.
2. **Assert the negative too.** Almost every case here checks both that the matching request was
   intercepted *and* that the near-identical one reached the network. A rule that matched
   everything would satisfy only the first half.
3. **Name the rule you need.** `rules: [...]` is matched against the config the extension pushes
   into the page, so an unseeded rule makes the case skip with a reason instead of failing. Red
   means a regression, always.

## Adding a rule

Rules live in `rules.mjs`, grouped by suite, and **order is the priority model** — a new rule goes
under a `/pg/<suite>/...` path that nothing above it matches. The commonest mistake is a url that
sits under an earlier `contains` or `startsWith` pattern: `/pg/match/starts-path` is matched by the
rule for `/pg/match/starts`, and the case then fails for a reason that has nothing to do with what
it was testing.

The page compares the seeded config against `buildRules()` and shows the difference in the **Rule
set** tab, so a rule you added but did not seed is visible rather than mysterious.
