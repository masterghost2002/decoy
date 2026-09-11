import { METHOD_ANY, type MockRule } from '@mocksmith/core';
import { ChevronDown, ChevronUp, Copy, ListPlus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import { Button } from '@/ui/components/ui/button';
import { EmptyState } from '@/ui/components/ui/empty-state';
import { Input } from '@/ui/components/ui/input';
import { MethodPill, Pill, StatusPill } from '@/ui/components/ui/pill';
import { Switch } from '@/ui/components/ui/switch';
import { cn } from '@/ui/lib/utils';

/** Above this many rules, scanning beats scrolling, so a filter appears. */
const FILTER_THRESHOLD = 6;

export interface RuleListProps {
  rules: MockRule[];
  selectedRuleId: string | null;
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
  onMove: (ruleId: string, offset: number) => void;
  onDuplicate: (ruleId: string) => void;
  onCreate: () => void;
}

function ActionSummary({ rule }: { rule: MockRule }) {
  switch (rule.action.kind) {
    case 'respond':
      return <StatusPill status={rule.action.status} />;
    case 'networkError':
      return <Pill className="border-danger/35 text-danger">{rule.action.errorType}</Pill>;
    case 'passthrough':
      return <Pill className="border-hairline-strong text-ink-faint">real</Pill>;
  }
}

export function RuleList({
  rules,
  selectedRuleId,
  onSelect,
  onToggle,
  onMove,
  onDuplicate,
  onCreate,
}: RuleListProps) {
  const [query, setQuery] = useState('');

  const visibleRules = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return rules;
    return rules.filter(
      (rule) =>
        rule.name.toLowerCase().includes(needle) ||
        rule.matcher.url.value.toLowerCase().includes(needle),
    );
  }, [rules, query]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex items-center gap-2 border-b border-hairline bg-surface px-3.5 py-2">
        <h2 className="eyebrow flex-1">
          Rules
          <span className="ml-1.5 text-ink-muted">{rules.length}</span>
        </h2>
        <Button size="sm" variant="primary" onClick={onCreate}>
          <Plus />
          New rule
        </Button>
      </div>

      {rules.length >= FILTER_THRESHOLD ? (
        <div className="border-b border-hairline bg-surface px-3.5 py-2">
          <Input
            type="search"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            placeholder="Filter by name or url"
            aria-label="Filter rules"
          />
        </div>
      ) : null}

      {rules.length === 0 ? (
        <EmptyState
          icon={ListPlus}
          title="No rules yet"
          description="Add a rule to take over a request: match its url, then answer with any status, body or failure you need to test."
          action={
            <Button variant="primary" onClick={onCreate}>
              <Plus />
              Create the first rule
            </Button>
          }
        />
      ) : visibleRules.length === 0 ? (
        <EmptyState
          icon={ListPlus}
          title="No matching rules"
          description={`Nothing matches “${query}”. Clear the filter to see all ${String(rules.length)} rules.`}
        />
      ) : (
        <ul className="min-h-0 flex-1 divide-y divide-hairline overflow-y-auto">
          {visibleRules.map((rule) => {
            const position = rules.indexOf(rule);
            const isSelected = rule.id === selectedRuleId;

            return (
              <li
                key={rule.id}
                className={cn(
                  'group flex items-center gap-2.5 border-l-2 py-1.5 pr-2 pl-3',
                  // A gold rail plus a warm wash, rather than a filled block:
                  // selection should not shout louder than the rule's own state.
                  isSelected
                    ? 'border-gold bg-wash'
                    : 'border-transparent hover:bg-surface',
                )}
              >
                <Switch
                  checked={rule.enabled}
                  onCheckedChange={(checked) => {
                    onToggle(rule.id, checked);
                  }}
                  aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${rule.name}`}
                />

                <button
                  type="button"
                  onClick={() => {
                    onSelect(rule.id);
                  }}
                  aria-current={isSelected}
                  className="min-w-0 flex-1 text-left"
                >
                  <span
                    className={cn(
                      'block truncate text-[13px] font-medium',
                      rule.enabled ? 'text-ink' : 'text-ink-faint',
                    )}
                  >
                    {rule.name.length > 0 ? rule.name : 'Untitled rule'}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1.5">
                    <MethodPill
                      method={
                        rule.matcher.methods.includes(METHOD_ANY) || rule.matcher.methods.length > 1
                          ? METHOD_ANY
                          : (rule.matcher.methods[0] ?? METHOD_ANY)
                      }
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-ink-muted">
                      {rule.matcher.url.value}
                    </span>
                    <ActionSummary rule={rule} />
                  </span>
                </button>

                <div className="flex flex-col opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={position === 0}
                    aria-label={`Move ${rule.name} up`}
                    onClick={() => {
                      onMove(rule.id, -1);
                    }}
                  >
                    <ChevronUp />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    disabled={position === rules.length - 1}
                    aria-label={`Move ${rule.name} down`}
                    onClick={() => {
                      onMove(rule.id, 1);
                    }}
                  >
                    <ChevronDown />
                  </Button>
                </div>

                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={`Duplicate ${rule.name}`}
                  className="opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
                  onClick={() => {
                    onDuplicate(rule.id);
                  }}
                >
                  <Copy />
                </Button>
              </li>
            );
          })}
        </ul>
      )}

      <p className="eyebrow border-t border-hairline bg-surface px-3.5 py-2">
        First enabled match wins
      </p>
    </div>
  );
}
