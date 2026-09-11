import { firstUrlMatch, matchesUrl, type MockRule } from '@decoy/core';
import { useMemo, useState } from 'react';

import { Label } from '@/ui/components/ui/field';
import { Input } from '@/ui/components/ui/input';
import { Pill } from '@/ui/components/ui/pill';
import { formatOrdinal } from '@/ui/lib/utils';

export interface UrlMatchTesterProps {
  /** The rule being edited, as drafted -- unsaved patterns are testable too. */
  rule: MockRule;
  /** The saved list, so the answer can name the rule that actually wins. */
  rules: MockRule[];
}

interface Verdict {
  matches: boolean;
  explanation: string;
}

/**
 * The strongest explanatory device in the product: paste the url from the
 * network panel, get an answer. It beats any amount of prose about match modes,
 * which is why it is always on screen somewhere.
 *
 * Upgraded from "does this rule match?" to "which rule wins?" -- the second is
 * the question people actually have, and the first is the one that leaves them
 * staring at a rule that matches and still never fires.
 */
export function UrlMatchTester({ rule, rules }: UrlMatchTesterProps) {
  const [candidate, setCandidate] = useState('');

  const verdict = useMemo<Verdict | null>(() => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return null;

    const matches = matchesUrl(rule.matcher.url, trimmed);
    const hasConditions = rule.matcher.conditions.some((condition) => condition.enabled);

    if (!matches) {
      return {
        matches: false,
        explanation:
          'This pattern does not match. Try the contains mode, or widen the pattern — and check whether you meant a path or a full url.',
      };
    }

    if (!rule.enabled) {
      return {
        matches: true,
        explanation:
          'The url matches, but this rule is switched off, so it will not answer anything. Turn it on in the list.',
      };
    }

    // Where this rule sits relative to everything above it is the part a
    // per-rule test cannot see, and the part that costs people an afternoon.
    const winner = firstUrlMatch(rules, trimmed);
    const isWinner = winner.rule?.id === rule.id;

    if (winner.rule !== null && !isWinner) {
      const position = formatOrdinal(winner.index);
      const name = winner.rule.name.length > 0 ? winner.rule.name : 'Untitled rule';
      const ownIndex = rules.findIndex((candidateRule) => candidateRule.id === rule.id);
      const isAbove = ownIndex !== -1 && winner.index < ownIndex;
      return {
        matches: true,
        explanation: isAbove
          ? `The url matches, but rule ${position} “${name}” is above this one and answers it first. Move this rule above ${position} to use it.`
          : `The url matches, and rule ${position} “${name}” also matches it.`,
      };
    }

    const suffix = hasConditions
      ? ' Conditions are not tested here, so a real request must also satisfy those.'
      : ' A real request also has to use one of the selected methods.';

    if (winner.uncertain) {
      return {
        matches: true,
        explanation: `This rule wins for this url unless a rule above it accepts the request too — one of them matches the url but also tests the method or the payload.${suffix}`,
      };
    }

    return {
      matches: true,
      explanation: `Nothing above this rule matches this url, so this rule wins.${suffix}`,
    };
  }, [rule, rules, candidate]);

  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface p-2.5 shadow-ring">
      <div className="flex items-center justify-between gap-2">
        {/* Named for what it answers, not for what you type into it. */}
        <Label htmlFor="decoy-url-tester">Which rule wins?</Label>
        {verdict === null ? null : (
          <Pill
            className={
              verdict.matches ? 'border-ok/45 bg-ok/10 text-ok' : 'border-danger/40 text-danger'
            }
          >
            {verdict.matches ? 'matches' : 'no match'}
          </Pill>
        )}
      </div>
      <Input
        id="decoy-url-tester"
        value={candidate}
        onChange={(event) => {
          setCandidate(event.target.value);
        }}
        placeholder="https://api.example.com/v1/users?page=2"
        className="font-mono text-[13px]"
        autoComplete="off"
      />
      <p className="helper" aria-live="polite">
        {verdict === null
          ? 'Paste a url from the network panel to see which rule would answer it. This only tests — it changes nothing.'
          : verdict.explanation}
      </p>
    </div>
  );
}
