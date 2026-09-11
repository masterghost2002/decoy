import { TRAFFIC_OUTCOMES, type TrafficEntry, type TrafficOutcome } from '@mocksmith/core';
import { Radio, Trash2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Badge, StatusBadge } from '@/ui/components/ui/badge';
import { Button } from '@/ui/components/ui/button';
import { EmptyState } from '@/ui/components/ui/empty-state';
import { Input, Select } from '@/ui/components/ui/input';
import { cn } from '@/ui/lib/utils';
import { formatClockTime, formatDuration, shortenUrl } from '@/ui/lib/utils';

const OUTCOME_LABEL: Record<TrafficOutcome, string> = {
  mocked: 'mocked',
  passthrough: 'real',
  failed: 'failed',
};

export interface TrafficTableProps {
  entries: TrafficEntry[];
  onClear: () => void;
  /** When set, the list defaults to just this tab's requests. */
  activeTabId: number | null;
  onMockRequest: (entry: TrafficEntry) => void;
}

export function TrafficTable({
  entries,
  onClear,
  activeTabId,
  onMockRequest,
}: TrafficTableProps) {
  const [outcome, setOutcome] = useState<TrafficOutcome | 'all'>('all');
  const [query, setQuery] = useState('');
  const [thisTabOnly, setThisTabOnly] = useState(activeTabId !== null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (outcome !== 'all' && entry.outcome !== outcome) return false;
      if (thisTabOnly && activeTabId !== null && entry.tabId !== activeTabId) return false;
      if (needle.length > 0 && !entry.url.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [entries, outcome, query, thisTabOnly, activeTabId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-2">
        <Input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Filter by url"
          aria-label="Filter requests by url"
          className="min-w-32 flex-1"
        />
        <Select
          value={outcome}
          aria-label="Filter by outcome"
          className="w-28"
          onChange={(event) => {
            setOutcome(event.target.value as TrafficOutcome | 'all');
          }}
        >
          <option value="all">all</option>
          {TRAFFIC_OUTCOMES.map((value) => (
            <option key={value} value={value}>
              {OUTCOME_LABEL[value]}
            </option>
          ))}
        </Select>
        {activeTabId !== null ? (
          <Button
            size="sm"
            variant={thisTabOnly ? 'primary' : 'secondary'}
            aria-pressed={thisTabOnly}
            onClick={() => {
              setThisTabOnly((current) => !current);
            }}
          >
            This tab
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" onClick={onClear} disabled={entries.length === 0}>
          <Trash2 />
          Clear
        </Button>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="No requests captured yet"
          description="Reload the page you are working on. Every fetch and XHR it makes shows up here, whether a rule handled it or not."
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="Nothing matches these filters"
          description={`${String(entries.length)} requests captured, none matching the current filters.`}
        />
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto">
          {visible.map((entry) => (
            <li key={entry.id} className="group flex items-center gap-2 px-3 py-1.5 text-xs">
              <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
                {formatClockTime(entry.startedAt)}
              </span>
              <span className="w-11 shrink-0 font-mono text-[10px] font-semibold text-muted-foreground">
                {entry.method}
              </span>
              <StatusBadge status={entry.status} />
              <span
                className="min-w-0 flex-1 truncate font-mono text-[11px]"
                title={entry.url}
              >
                {shortenUrl(entry.url, 80)}
              </span>
              <Badge
                tone={
                  entry.outcome === 'mocked'
                    ? 'accent'
                    : entry.outcome === 'failed'
                      ? 'danger'
                      : 'neutral'
                }
                title={entry.ruleName ?? undefined}
              >
                {OUTCOME_LABEL[entry.outcome]}
              </Badge>
              <span
                className={cn(
                  'w-12 shrink-0 text-right font-mono text-[10px]',
                  entry.durationMs > 1000 ? 'text-foreground' : 'text-muted-foreground',
                )}
              >
                {formatDuration(entry.durationMs)}
              </span>
              <span className="w-10 shrink-0 font-mono text-[10px] uppercase text-muted-foreground">
                {entry.transport}
              </span>
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={`Create a rule for ${entry.url}`}
                title="Create a rule for this request"
                className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                onClick={() => {
                  onMockRequest(entry);
                }}
              >
                <Wand2 />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
