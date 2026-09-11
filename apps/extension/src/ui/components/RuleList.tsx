import {
  METHOD_ANY,
  formatSince,
  readRuleStat,
  type MockRule,
  type RuleStats,
  type ShadowMap,
} from '@decoy/core';
import {
  ArrowDown,
  ArrowUp,
  ChevronsUp,
  Copy,
  GripVertical,
  ListPlus,
  MoreHorizontal,
  Plus,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/ui/components/ui/button';
import { EmptyState } from '@/ui/components/ui/empty-state';
import { HelpPopover } from '@/ui/components/ui/help-popover';
import { Input } from '@/ui/components/ui/input';
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from '@/ui/components/ui/menu';
import { MethodPill, Pill } from '@/ui/components/ui/pill';
import { Switch } from '@/ui/components/ui/switch';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { useTicker } from '@/ui/hooks/useTicker';
import { cn, formatOrdinal } from '@/ui/lib/utils';

/** Past this, "fired 40s ago" stops being news and decays to a plain count. */
const FRESH_HIT_MS = 60_000;

export interface RuleListProps {
  rules: MockRule[];
  stats: RuleStats;
  /** Rules an earlier enabled rule already swallows, keyed by rule id. */
  shadows: ShadowMap;
  selectedRuleId: string | null;
  /** Set briefly after a save, so the row you just changed is the one you see. */
  flashRuleId?: string | null;
  filterRef?: React.RefObject<HTMLInputElement | null>;
  onSelect: (ruleId: string) => void;
  onToggle: (ruleId: string, enabled: boolean) => void;
  onMove: (ruleId: string, offset: number) => void;
  onMoveToTop: (ruleId: string) => void;
  onMoveToIndex: (ruleId: string, index: number) => void;
  onDuplicate: (ruleId: string) => void;
  onDelete: (ruleId: string) => void;
  onCreate: () => void;
}

function ActionSummary({ rule }: { rule: MockRule }) {
  switch (rule.action.kind) {
    case 'respond':
      return <StatusSummary status={rule.action.status} />;
    case 'stream':
      // One pill, both facts. A second pill beside the status would be the
      // fourth thing competing for the end of a row that already truncates.
      return <StatusSummary status={rule.action.status} suffix="stream" />;
    case 'handler':
      // No status to show: the handler decides it per request, and a number
      // here would be a guess presented as a fact.
      return <Pill className="border-gold-text/50 text-gold-text">js</Pill>;
    case 'networkError':
      return <Pill className="border-danger/40 text-danger">{rule.action.errorType}</Pill>;
    case 'passthrough':
      return <Pill className="border-dashed border-hairline-strong text-ink-muted">real</Pill>;
  }
}

function StatusSummary({ status, suffix }: { status: number; suffix?: string }) {
  const tone =
    status >= 500
      ? 'border-danger/40 text-danger'
      : status >= 400
        ? 'border-warn/45 text-warn'
        : status >= 300
          ? 'border-info/40 text-info'
          : 'border-ok/40 text-ok';
  return (
    <Pill className={tone}>
      {status}
      {suffix === undefined ? null : <span className="text-ink-muted">{suffix}</span>}
    </Pill>
  );
}

/**
 * Per-rule proof that the thing is working. Fresh hits say when, in gold,
 * because "this rule is the one doing the work -- and that one has never
 * fired" is the question a rule list otherwise cannot answer. Older hits decay
 * to a plain count, which stops being news but is still evidence.
 *
 * The "fired 9s ago" half is dropped when the column is too narrow to carry it,
 * because the url it would otherwise squeeze out matters more. Keyed to the
 * container rather than the viewport: the same list is 420px in the popup and
 * 280-340px in the tab view's left pane. The full sentence stays available to
 * screen readers either way.
 */
function FiredStamp({ hits, lastHitAt, now }: { hits: number; lastHitAt: number; now: number }) {
  if (hits === 0) return null;

  const fresh = lastHitAt > 0 && now - lastHitAt < FRESH_HIT_MS;
  const since = formatSince(lastHitAt, now);

  return (
    <span
      className={cn(
        'tabular shrink-0 font-mono text-[11px] whitespace-nowrap',
        fresh ? 'text-gold-text' : 'text-ink-muted',
      )}
      aria-label={fresh ? `fired ${since}, ${String(hits)} times` : `fired ${String(hits)} times`}
    >
      {fresh ? <span className="hidden @[25rem]:inline">· fired {since} </span> : null}· {hits}
      &times;
    </span>
  );
}

export function RuleList({
  rules,
  stats,
  shadows,
  selectedRuleId,
  flashRuleId = null,
  filterRef,
  onSelect,
  onToggle,
  onMove,
  onMoveToTop,
  onMoveToIndex,
  onDuplicate,
  onDelete,
  onCreate,
}: RuleListProps) {
  const [query, setQuery] = useState('');
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const draggingId = useRef<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLButtonElement>());

  const visibleRules = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length === 0) return rules;
    return rules.filter(
      (rule) =>
        rule.name.toLowerCase().includes(needle) ||
        rule.matcher.url.value.toLowerCase().includes(needle),
    );
  }, [rules, query]);

  /*
   * Only tick while a stamp is still young enough to change. Reading the clock
   * during render is exactly what "is this recent?" means, and `useTicker` is
   * the subscription that makes the answer update rather than go stale.
   */
  const hasFreshHit = rules.some((rule) => {
    const stat = readRuleStat(stats, rule.id);
    // eslint-disable-next-line react-hooks/purity
    return stat.hits > 0 && Date.now() - stat.lastHitAt < FRESH_HIT_MS;
  });
  const now = useTicker(hasFreshHit);

  // A new rule created from a traffic row lands wherever the list happens to
  // be scrolled to. Silently switching panels and showing nothing is the same
  // as doing nothing.
  useEffect(() => {
    if (flashRuleId === null) return;
    rowRefs.current.get(flashRuleId)?.scrollIntoView({ block: 'nearest' });
  }, [flashRuleId]);

  /**
   * Dragging is the discoverable way to reorder; this is the one that works
   * without a mouse. Reordering is the product's central interaction, so
   * drag-only would make it unusable by keyboard and by anyone with a motor
   * impairment.
   *
   * Bound to the row wrapper so it also fires while focus is on the switch or
   * the `⋯` trigger. Alt-arrow is not claimed by any native control, so
   * intercepting it here steps on nothing.
   */
  const handleReorderKeys = (event: React.KeyboardEvent, rule: MockRule) => {
    if (!event.altKey) return;
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    onMove(rule.id, event.key === 'ArrowUp' ? -1 : 1);
    // Focus follows the rule, not the position it left behind.
    requestAnimationFrame(() => {
      rowRefs.current.get(rule.id)?.focus();
    });
  };

  /**
   * Plain arrows walk the list and Space toggles, which means Space cannot also
   * activate the row the way a button normally would. Enter and a click still
   * open it, so nothing is lost -- and toggling is the far more frequent act.
   */
  const handleRowKeys = (event: React.KeyboardEvent, rule: MockRule) => {
    if (event.altKey) return;

    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const offset = event.key === 'ArrowUp' ? -1 : 1;
      const neighbour = visibleRules[visibleRules.indexOf(rule) + offset];
      if (neighbour === undefined) return;
      event.preventDefault();
      rowRefs.current.get(neighbour.id)?.focus();
      return;
    }

    if (event.key === ' ') {
      event.preventDefault();
      onToggle(rule.id, !rule.enabled);
    }
  };

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

      {/* Unconditional. It used to appear once the list passed six rules, which
          meant adding a sixth rule inserted a row and pushed the whole list
          down -- and left `⌘K` with nothing to focus below that. */}
      <div className="shrink-0 border-b border-hairline bg-surface px-3.5 py-2">
        <Input
          ref={filterRef}
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          placeholder="Filter by name or url"
          aria-label="Filter rules"
        />
      </div>

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
          action={
            <Button
              onClick={() => {
                setQuery('');
              }}
            >
              Clear filter
            </Button>
          }
        />
      ) : (
        <ul className="@container min-h-0 flex-1 divide-y divide-hairline overflow-y-auto">
          {visibleRules.map((rule) => {
            const position = rules.indexOf(rule);
            const isSelected = rule.id === selectedRuleId;
            const stat = readRuleStat(stats, rule.id);
            const label = rule.name.length > 0 ? rule.name : 'Untitled rule';
            const shadow = shadows[rule.id];
            const shadowedBy = shadow === undefined ? null : formatOrdinal(shadow.shadowedByIndex);

            return (
              <li
                key={rule.id}
                onDragOver={(event) => {
                  if (draggingId.current === null) return;
                  event.preventDefault();
                  setDragOverIndex(position);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  const moved = draggingId.current;
                  draggingId.current = null;
                  setDragOverIndex(null);
                  if (moved !== null && moved !== rule.id) onMoveToIndex(moved, position);
                }}
                className={cn(
                  // Side-specific colour utilities: a bare `border-gold` would
                  // also repaint the divider `divide-y` draws on this element.
                  'flex flex-col border-l-[3px] border-l-transparent',
                  // Selection is the neutral surface lift. The rail on top of it
                  // is gold only when the selected rule is actually enabled, so
                  // the accent still only ever says "intercepting" -- a gold rail
                  // on every enabled row is eleven gold rails, which says nothing.
                  isSelected && (rule.enabled ? 'border-l-gold' : 'border-l-hairline-strong'),
                  isSelected ? 'bg-wash' : 'hover:bg-surface',
                  dragOverIndex === position && 'shadow-[inset_0_2px_0_var(--ink)]',
                  flashRuleId === rule.id && 'animate-flash',
                )}
              >
                <div
                  className="flex items-center gap-2 py-1 pr-1.5 pl-1"
                  onKeyDown={(event) => {
                    handleReorderKeys(event, rule);
                  }}
                >
                  {/* Position is the entire priority model, so it stays visible
                      at all times -- and it doubles as the drag handle. The
                      number never gives way to a grip icon: it is needed most
                      at exactly the moment the cursor is over it. */}
                  <Tooltip label="Drag to reorder, or ⌥↑ / ⌥↓">
                    <button
                      type="button"
                      draggable
                      onDragStart={(event) => {
                        draggingId.current = rule.id;
                        event.dataTransfer.effectAllowed = 'move';
                        event.dataTransfer.setData('text/plain', rule.id);
                      }}
                      onDragEnd={() => {
                        draggingId.current = null;
                        setDragOverIndex(null);
                      }}
                      aria-label={`Reorder ${label}, currently ${String(position + 1)} of ${String(rules.length)}`}
                      className={cn(
                        'tabular flex w-[26px] shrink-0 cursor-grab items-center justify-end gap-px rounded font-mono text-[11px] hover:text-ink active:cursor-grabbing',
                        shadow !== undefined
                          ? 'text-warn'
                          : isSelected
                            ? 'text-gold-text'
                            : 'text-ink-label',
                      )}
                    >
                      <GripVertical aria-hidden className="size-3 shrink-0 opacity-40" />
                      {formatOrdinal(position)}
                    </button>
                  </Tooltip>

                  <Switch
                    checked={rule.enabled}
                    onCheckedChange={(checked) => {
                      onToggle(rule.id, checked);
                    }}
                    aria-label={`${rule.enabled ? 'Disable' : 'Enable'} ${label}`}
                  />

                  <button
                    type="button"
                    ref={(node) => {
                      if (node === null) rowRefs.current.delete(rule.id);
                      else rowRefs.current.set(rule.id, node);
                    }}
                    onClick={() => {
                      onSelect(rule.id);
                    }}
                    onKeyDown={(event) => {
                      handleRowKeys(event, rule);
                    }}
                    aria-current={isSelected}
                    className="min-w-0 flex-1 overflow-hidden text-left"
                  >
                    {/* The stamp shares the name line rather than the meta
                        line below. Both lines are tight, but a truncated name
                        is still recognisable where a truncated url is not, so
                        the name is the one that gives way. */}
                    <span className="flex items-baseline gap-1.5 overflow-hidden">
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-[14px] leading-[20px] font-semibold tracking-[-0.01em]',
                          rule.enabled ? 'text-ink' : 'text-ink-label',
                        )}
                      >
                        {label}
                      </span>
                      <FiredStamp hits={stat.hits} lastHitAt={stat.lastHitAt} now={now} />
                    </span>
                    <span className="flex items-center gap-1.5 overflow-hidden">
                      <MethodPill
                        method={
                          rule.matcher.methods.includes(METHOD_ANY) ||
                          rule.matcher.methods.length > 1
                            ? METHOD_ANY
                            : (rule.matcher.methods[0] ?? METHOD_ANY)
                        }
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate font-mono text-[12px]',
                          rule.enabled ? 'text-ink-muted' : 'text-ink-label',
                        )}
                      >
                        {rule.matcher.url.value}
                      </span>
                      {rule.matcher.conditions.some((condition) => condition.enabled) ? (
                        <Pill className="hidden border-info/40 text-info @[21rem]:inline-flex">
                          +if
                        </Pill>
                      ) : null}
                      <ActionSummary rule={rule} />
                    </span>
                  </button>

                  {/* Always visible. Reordering and deleting are core actions
                      and must not require discovering a hover state first. */}
                  <Menu>
                    <MenuTrigger asChild>
                      <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${label}`}>
                        <MoreHorizontal />
                      </Button>
                    </MenuTrigger>
                    <MenuContent>
                      <MenuItem
                        disabled={position === 0}
                        onSelect={() => {
                          onMove(rule.id, -1);
                        }}
                      >
                        <ArrowUp />
                        Move up
                      </MenuItem>
                      <MenuItem
                        disabled={position === rules.length - 1}
                        onSelect={() => {
                          onMove(rule.id, 1);
                        }}
                      >
                        <ArrowDown />
                        Move down
                      </MenuItem>
                      <MenuItem
                        disabled={position === 0}
                        onSelect={() => {
                          onMoveToTop(rule.id);
                        }}
                      >
                        <ChevronsUp />
                        Move to top
                      </MenuItem>
                      <MenuSeparator />
                      <MenuItem
                        onSelect={() => {
                          onDuplicate(rule.id);
                        }}
                      >
                        <Copy />
                        Duplicate
                      </MenuItem>
                      <MenuItem
                        destructive
                        onSelect={() => {
                          onDelete(rule.id);
                        }}
                      >
                        <Trash2 />
                        Delete
                      </MenuItem>
                    </MenuContent>
                  </Menu>
                </div>

                {/* Named, not silent. This converts the one hard concept in the
                    product from something you learn by losing an afternoon into
                    something the list tells you. */}
                {shadow !== undefined && shadowedBy !== null ? (
                  <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-hairline bg-sunk px-2 py-1.5 text-[12px] leading-snug text-warn">
                    <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
                    <span className="min-w-0">
                      Never fires — {shadowedBy} matches everything this rule does
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      className="ml-auto"
                      onClick={() => {
                        onMoveToIndex(rule.id, shadow.shadowedByIndex);
                      }}
                    >
                      Move above {shadowedBy}
                    </Button>
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex items-center gap-2 border-t border-hairline bg-surface px-3.5 py-2">
        <p className="eyebrow">First enabled match wins</p>
        <HelpPopover title="How priority works" side="top">
          <p>
            Rules are evaluated top to bottom. The first <b>enabled</b> rule whose url, method and
            conditions all match answers the request; everything below it is skipped for that
            request.
          </p>
          <p>
            So a broad rule near the top hides the narrow ones under it. Put exceptions — including{' '}
            <b>pass through</b> — above the rule they carve out of.
          </p>
          <p>
            Drag a row by its number to reorder, or focus it and press <b>⌥↑</b> / <b>⌥↓</b>.
          </p>
        </HelpPopover>
      </div>
    </div>
  );
}
