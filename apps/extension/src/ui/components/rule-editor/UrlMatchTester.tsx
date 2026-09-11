import { matchesUrl, type UrlMatcher } from '@mocksmith/core';
import { useMemo, useState } from 'react';

import { Badge } from '@/ui/components/ui/badge';
import { Input } from '@/ui/components/ui/input';
import { Label } from '@/ui/components/ui/field';

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
    if (candidate.trim().length === 0) return null;
    return matchesUrl(matcher, candidate.trim());
  }, [matcher, candidate]);

  return (
    <div className="flex flex-col gap-1 rounded-md border border-border bg-card-muted p-2">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor="mocksmith-url-tester">Test a url</Label>
        {result === null ? null : (
          <Badge tone={result ? 'success' : 'outline'}>{result ? 'matches' : 'no match'}</Badge>
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
