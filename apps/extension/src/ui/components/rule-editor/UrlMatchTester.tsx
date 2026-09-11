import { matchesUrl, type UrlMatcher } from '@mocksmith/core';
import { useMemo, useState } from 'react';

import { Label } from '@/ui/components/ui/field';
import { Input } from '@/ui/components/ui/input';
import { Pill } from '@/ui/components/ui/pill';

export interface UrlMatchTesterProps {
  matcher: UrlMatcher;
}

/**
 * "Why didn't my rule fire?" is the question this tool has to answer fastest.
 * Pasting the url straight from the network panel and getting a yes or no beats
 * any amount of documentation about match modes.
 */
export function UrlMatchTester({ matcher }: UrlMatchTesterProps) {
  const [candidate, setCandidate] = useState('');

  const result = useMemo(() => {
    const trimmed = candidate.trim();
    if (trimmed.length === 0) return null;
    return matchesUrl(matcher, trimmed);
  }, [matcher, candidate]);

  return (
    <div className="flex flex-col gap-1.5 rounded-xl bg-surface p-2.5 shadow-ring">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="mocksmith-url-tester">Try a url</Label>
        {result === null ? null : (
          <Pill
            className={
              result ? 'border-ok/45 bg-ok/10 text-ok' : 'border-hairline-strong text-ink-faint'
            }
          >
            {result ? 'matches' : 'no match'}
          </Pill>
        )}
      </div>
      <Input
        id="mocksmith-url-tester"
        value={candidate}
        onChange={(event) => {
          setCandidate(event.target.value);
        }}
        placeholder="https://api.example.com/v1/users?page=2"
        className="font-mono text-xs"
        autoComplete="off"
      />
    </div>
  );
}
