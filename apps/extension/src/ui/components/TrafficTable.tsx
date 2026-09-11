import {
  TRAFFIC_OUTCOMES,
  type MockRule,
  type TrafficEntry,
  type TrafficOutcome,
} from '@mocksmith/core';
import { Radio, Trash2, Wand2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { TrafficDetail } from '@/ui/components/TrafficDetail';
import { Button } from '@/ui/components/ui/button';
import { Chip, ChipGroup } from '@/ui/components/ui/chip';
import { EmptyState } from '@/ui/components/ui/empty-state';
import { Input } from '@/ui/components/ui/input';
import { MethodPill, OutcomePill, StatusPill } from '@/ui/components/ui/pill';
import { cn, formatClockTime, formatDuration, formatOrdinal, shortenUrl } from '@/ui/lib/utils';

type OutcomeFilter = TrafficOutcome | 'all';

const OUTCOME_FILTER_LABEL: Record<OutcomeFilter, string> = {
  all: 'all',
  mocked: 'mocked',
  passthrough: 'real',
  failed: 'failed',
};

const OUTCOME_FILTERS: OutcomeFilter[] = ['all', ...TRAFFIC_OUTCOMES];

/** Past this, a response is slow enough that the number deserves attention. */
const SLOW_MS = 1000;

export interface TrafficTableProps {
  entries: TrafficEntry[];
  onClear: () => void;
  /** When set, the list defaults to just this tab's requests. */
  activeTabId: number | null;
  onMockRequest: (entry: TrafficEntry) => void;
  /** Used to name the deciding rule by its current position: "by 02 Users 404". */
  rules: MockRule[];
  /**
   * True when the worker restarted and dropped the log. An empty list then
   * means something quite different from "no requests happened", and the two
   * must not look identical.
   */
  logWasCleared: boolean;
  filterRef?: React.RefObject<HTMLInputElement | null>;
}

/**
 * Which rule decided this request, as visible text rather than a `title`.
 * "MOCKED by 02 Users 404" is the row saying exactly what happened and why,
 * and it is also how someone learns that position is the priority model.
 */
function Decider({ entry, rules }: { entry: TrafficEntry; rules: MockRule[] }) {
  if (entry.ruleId === null) {
    return (
      <span className="hidden truncate font-mono text-[11px] text-ink-label lg:block lg:w-52">
        no rule matched
      </span>
    );
  }

  const index = rules.findIndex((rule) => rule.id === entry.ruleId);
  const name = entry.ruleName ?? 'a deleted rule';

  return (
    <span className="hidden truncate font-mono text-[11px] text-ink-muted lg:block lg:w-52">
      by {index === -1 ? '' : `${formatOrdinal(index)} `}
      {name}
    </span>
  );
}

export function TrafficTable({
  entries,
  onClear,
  activeTabId,
  onMockRequest,
  rules,
  logWasCleared,
  filterRef,
}: TrafficTableProps) {
  const [outcome, setOutcome] = useState<OutcomeFilter>('all');
  const [query, setQuery] = useState('');
  const [thisTabOnly, setThisTabOnly] = useState(activeTabId !== null);
  const [selected, setSelected] = useState<TrafficEntry | null>(null);

  /**
   * Scoped and text-filtered, but *not* outcome-filtered: the counts on the
   * outcome chips have to describe what picking each one would show. A count
   * that changes when you select it is not a count.
   */
  const scoped = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return entries.filter((entry) => {
      if (thisTabOnly && activeTabId !== null && entry.tabId !== activeTabId) return false;
      if (needle.length > 0 && !entry.url.toLowerCase().includes(needle)) return false;
      return true;
    });
  }, [entries, query, thisTabOnly, activeTabId]);

  const counts = useMemo(() => {
    const tally: Record<OutcomeFilter, number> = {
      all: scoped.length,
      mocked: 0,
      passthrough: 0,
      failed: 0,
    };
    for (const entry of scoped) tally[entry.outcome] += 1;
    return tally;
  }, [scoped]);

  const visible = useMemo(
    () => (outcome === 'all' ? scoped : scoped.filter((entry) => entry.outcome === outcome)),
    [scoped, outcome],
  );

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex flex-col gap-2 border-b border-hairline bg-surface px-3.5 py-2">
        <div className="flex items-center gap-1.5">
          <Input
            ref={filterRef}
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Filter by url"
            aria-label="Filter requests by url"
            className="min-w-32 flex-1 font-mono text-[13px]"
          />
          <Button size="sm" variant="ghost" onClick={onClear} disabled={entries.length === 0}>
            <Trash2 />
            Clear
          </Button>
        </div>

        {/* Counted chips, not a dropdown. There are four values, each has a
            count, and the counts are the information -- a closed dropdown hides
            all four and, as shipped, was not even labelled. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="eyebrow" id="mocksmith-outcome-label">
            Outcome
          </span>
          <ChipGroup label="Filter by outcome" aria-labelledby="mocksmith-outcome-label">
            {OUTCOME_FILTERS.map((value) => (
              <Chip
                key={value}
                selected={outcome === value}
                count={counts[value]}
                onClick={() => {
                  setOutcome(value);
                }}
              >
                {OUTCOME_FILTER_LABEL[value]}
              </Chip>
            ))}
            {activeTabId !== null ? (
              <Chip
                selected={thisTabOnly}
                onClick={() => {
                  setThisTabOnly((current) => !current);
                }}
              >
                this tab
              </Chip>
            ) : null}
          </ChipGroup>
        </div>
      </div>

      {entries.length === 0 ? (
        <EmptyState
          icon={Radio}
          title={logWasCleared ? 'The log was dropped' : 'Listening for requests'}
          description={
            logWasCleared
              ? 'Chrome shut the extension’s worker down and the captured log went with it. Requests are still being intercepted — reload the page to start a new log.'
              : 'Reload the page you are working on. Every fetch and XHR it makes shows up here, whether a rule handled it or not.'
          }
        />
      ) : visible.length === 0 ? (
        <EmptyState
          icon={Radio}
          title="Nothing matches these filters"
          description={`${String(entries.length)} requests captured, none matching the current filters.`}
          action={
            <Button
              onClick={() => {
                setOutcome('all');
                setQuery('');
                setThisTabOnly(false);
              }}
            >
              Clear filters
            </Button>
          }
        />
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-hairline overflow-y-auto">
          {visible.map((entry) => (
            <li key={entry.id} className="flex items-center gap-2 pr-1.5 pl-3.5 hover:bg-surface">
              {/* The whole row opens the detail. A request you can see but not
                  inspect sends people back to the DevTools network panel. */}
              <button
                type="button"
                onClick={() => {
                  setSelected(entry);
                }}
                aria-label={`Inspect ${entry.method} ${entry.url}`}
                className="flex min-w-0 flex-1 items-center gap-2 py-1 text-left"
              >
                <span className="tabular w-[3.75rem] shrink-0 font-mono text-[11px] text-ink-label">
                  {formatClockTime(entry.startedAt)}
                </span>
                <MethodPill method={entry.method} />
                <StatusPill status={entry.status} />
                <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-ink lg:max-w-[26rem]">
                  {shortenUrl(entry.url, 80)}
                </span>
                <OutcomePill outcome={entry.outcome} />
                <Decider entry={entry} rules={rules} />
                <span
                  className={cn(
                    'tabular w-12 shrink-0 text-right font-mono text-[11px]',
                    entry.durationMs > SLOW_MS ? 'text-warn' : 'text-ink-label',
                  )}
                >
                  {formatDuration(entry.durationMs)}
                </span>
                <span className="w-9 shrink-0 font-mono text-[11px] uppercase text-ink-label">
                  {entry.transport}
                </span>
                {/* Absorbs the leftover width on a wide window, so the row's
                    content stays grouped on the left where it is read. */}
                <span aria-hidden className="hidden flex-1 lg:block" />
              </button>
              {/* Always visible and labelled in text. Turning a real request
                  into a rule is the path that teaches the whole product, which
                  is exactly why it must never be behind a hover. */}
              <Button
                size="sm"
                variant="secondary"
                aria-label={`Create a rule for ${entry.url}`}
                className="shrink-0"
                onClick={() => {
                  onMockRequest(entry);
                }}
              >
                <Wand2 />
                Mock this
              </Button>
            </li>
          ))}
        </ul>
      )}

      <TrafficDetail
        entry={selected}
        rules={rules}
        onClose={() => {
          setSelected(null);
        }}
        onMockRequest={onMockRequest}
      />
    </div>
  );
}
