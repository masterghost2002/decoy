/**
 * "Why didn't my rule fire?" answered before it is asked.
 *
 * Ordered, first-enabled-match-wins evaluation is the product's one hard
 * concept, and the way people learn it is by losing an afternoon to a broad
 * rule sitting above a narrow one. Everything here is computable from the
 * matchers, so the UI can say it out loud instead.
 *
 * The bar for reporting is soundness, not coverage. A false "never fires" badge
 * on a rule that does fire is far worse than staying quiet, so every test below
 * refuses to answer unless it can prove containment. Wildcard and regex
 * patterns are therefore skipped except where they are trivially universal.
 */
import { matchesUrl, type UrlMatcher } from './matching.js';
import { METHOD_ANY, type MethodPattern } from './http.js';
import type { MockRule } from './rule.js';

/** True when `outer` accepts every method `inner` accepts. */
function methodsCover(outer: MethodPattern[], inner: MethodPattern[]): boolean {
  const outerAny = outer.length === 0 || outer.includes(METHOD_ANY);
  if (outerAny) return true;

  // An empty or `*` inner list means "any method", which only `*` can cover.
  const innerAny = inner.length === 0 || inner.includes(METHOD_ANY);
  if (innerAny) return false;

  return inner.every((method) => outer.includes(method));
}

/**
 * A pattern that matches every url. Only `wildcard` can express this -- an
 * empty pattern never matches anything, by design, so that a half-typed rule
 * cannot hijack the whole page.
 */
function isUniversal(matcher: UrlMatcher): boolean {
  return matcher.mode === 'wildcard' && /^\*+$/.test(matcher.value);
}

/**
 * True when every url `inner` matches, `outer` also matches.
 *
 * The pairs handled here are the ones that arise in practice: a broad
 * `contains` above a specific rule, a shorter `startsWith` above a longer one,
 * a duplicated `equals`. Anything else returns false, which reports nothing.
 *
 * Scheme handling does not need special-casing. `contains` and `endsWith`
 * depend only on the full url -- a hit on the scheme-stripped candidate implies
 * a hit on the full one, since the stripped url is a suffix of it -- and for
 * `startsWith` the prefix relation carries through both candidates either way.
 */
function urlCovers(outer: UrlMatcher, inner: UrlMatcher): boolean {
  if (isUniversal(outer)) return true;
  if (outer.value.length === 0 || inner.value.length === 0) return false;

  // A case-sensitive outer pattern cannot cover a case-insensitive inner one:
  // the inner rule accepts casings the outer rule rejects.
  if (outer.caseSensitive && !inner.caseSensitive) return false;

  const fold = (value: string) => (outer.caseSensitive ? value : value.toLowerCase());
  const outerValue = fold(outer.value);
  const innerValue = fold(inner.value);

  switch (outer.mode) {
    case 'contains':
      // Any url containing the inner pattern also contains the outer one.
      return (
        (inner.mode === 'contains' ||
          inner.mode === 'equals' ||
          inner.mode === 'startsWith' ||
          inner.mode === 'endsWith') &&
        innerValue.includes(outerValue)
      );

    case 'startsWith':
      return (
        (inner.mode === 'startsWith' || inner.mode === 'equals') &&
        innerValue.startsWith(outerValue)
      );

    case 'endsWith':
      return (
        (inner.mode === 'endsWith' || inner.mode === 'equals') && innerValue.endsWith(outerValue)
      );

    case 'equals':
      return inner.mode === 'equals' && innerValue === outerValue;

    // A wildcard or regex haystack is not something to reason about with string
    // comparisons, and guessing would put a wrong badge on a working rule.
    case 'wildcard':
    case 'regex':
      return false;
  }
}

/**
 * True when `outer` would answer every request `inner` would.
 *
 * Two asymmetries, both of which make `outer` unable to shadow:
 *
 *  - any enabled condition on `outer` means it can decline a request `inner`
 *    accepts. Extra conditions on `inner` only narrow it, which is harmless.
 *  - a handler can decline too, by calling `next()`. That is not a corner
 *    case, it is the whole middleware pattern: a handler placed above the
 *    rules it guards is *supposed* to match everything they do and hand most
 *    of it on. Reporting that as "never fires" would put a warning on the
 *    intended arrangement.
 */
export function ruleCovers(outer: MockRule, inner: MockRule): boolean {
  if (outer.action.kind === 'handler') return false;
  if (outer.matcher.conditions.some((condition) => condition.enabled)) return false;
  if (!methodsCover(outer.matcher.methods, inner.matcher.methods)) return false;
  return urlCovers(outer.matcher.url, inner.matcher.url);
}

export interface ShadowedRule {
  ruleId: string;
  /** The earlier enabled rule that answers first. */
  shadowedBy: string;
  /** Its zero-based position, so the UI can name it as `01`, `02`, ... */
  shadowedByIndex: number;
}

export type ShadowMap = Record<string, ShadowedRule>;

/**
 * Rules that can never fire because something above them already matches
 * everything they do. Only enabled rules are reported: a disabled rule not
 * firing is not a surprise, and its row already says so.
 */
export function findShadowedRules(rules: readonly MockRule[]): ShadowMap {
  const shadowed: ShadowMap = {};

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule === undefined || !rule.enabled) continue;

    for (let earlier = 0; earlier < index; earlier += 1) {
      const above = rules[earlier];
      if (above === undefined || !above.enabled) continue;
      if (!ruleCovers(above, rule)) continue;

      shadowed[rule.id] = {
        ruleId: rule.id,
        shadowedBy: above.id,
        shadowedByIndex: earlier,
      };
      break;
    }
  }

  return shadowed;
}

export interface UrlMatchOutcome {
  /** The first enabled rule whose url pattern accepts this url, if any. */
  rule: MockRule | null;
  index: number;
  /**
   * True when an enabled rule ahead of the winner matches the url but carries
   * methods or conditions this test cannot evaluate. The real answer then
   * depends on the request, not just the url, and the UI has to say so.
   */
  uncertain: boolean;
}

/**
 * Which rule wins for a given url -- the question a user actually has, as
 * opposed to "does this one rule match?", which is what a per-rule tester can
 * answer on its own.
 *
 * Only the url matcher is evaluated, because a pasted url is all the tester
 * has. Rules that match the url but also test the method or the payload are
 * reported through `uncertain` rather than silently skipped or silently
 * counted.
 */
export function firstUrlMatch(rules: readonly MockRule[], url: string): UrlMatchOutcome {
  let uncertain = false;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule === undefined || !rule.enabled) continue;
    if (!matchesUrl(rule.matcher.url, url)) continue;

    const narrowed =
      !methodsCover(rule.matcher.methods, [METHOD_ANY]) ||
      rule.matcher.conditions.some((condition) => condition.enabled) ||
      // A handler decides per request, and may hand it on with next(). The url
      // cannot tell us which, so this is the same "might decline" case.
      rule.action.kind === 'handler';

    if (narrowed) {
      // It might win, and it might decline. Keep looking for a rule that is
      // decided by the url alone, and remember that the answer is conditional.
      uncertain = true;
      continue;
    }

    return { rule, index, uncertain };
  }

  return { rule: null, index: -1, uncertain };
}
