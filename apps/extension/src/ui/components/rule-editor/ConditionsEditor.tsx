import {
  CONDITION_OPERATORS,
  CONDITION_SOURCES,
  KEYLESS_SOURCES,
  VALUELESS_OPERATORS,
  createCondition,
  type ConditionMode,
  type ConditionOperator,
  type ConditionSource,
  type RuleCondition,
} from '@mocksmith/core';
import { Plus, Trash2 } from 'lucide-react';

import { Button } from '@/ui/components/ui/button';
import { Label, SectionHeading } from '@/ui/components/ui/field';
import { Input, Select } from '@/ui/components/ui/input';
import { Segmented, segmentedHint, type SegmentedOption } from '@/ui/components/ui/segmented';
import { Switch } from '@/ui/components/ui/switch';
import { cn } from '@/ui/lib/utils';

const CONDITION_MODE_OPTIONS: Array<SegmentedOption<ConditionMode>> = [
  {
    value: 'all',
    label: 'All',
    hint: 'Every enabled condition has to hold for the rule to match.',
  },
  {
    value: 'any',
    label: 'Any',
    hint: 'One enabled condition holding is enough for the rule to match.',
  },
];

const SOURCE_LABEL: Record<ConditionSource, string> = {
  header: 'Header',
  cookie: 'Cookie',
  query: 'Query param',
  body: 'Body text',
  jsonPath: 'Body JSON',
};

const SOURCE_HINT: Record<ConditionSource, string> = {
  header: 'Request header, matched by name without regard to case.',
  cookie: 'A cookie readable by the page. HttpOnly cookies are invisible here.',
  query: 'A single query string parameter, already percent-decoded.',
  body: 'The raw request payload as sent.',
  jsonPath: 'A dotted path into a JSON payload, e.g. user.role or items.0.id.',
};

const KEY_PLACEHOLDER: Record<ConditionSource, string> = {
  header: 'authorization',
  cookie: 'session',
  query: 'page',
  body: '',
  jsonPath: 'user.role',
};

const OPERATOR_LABEL: Record<ConditionOperator, string> = {
  exists: 'is present',
  notExists: 'is missing',
  equals: 'equals',
  notEquals: 'does not equal',
  contains: 'contains',
  notContains: 'does not contain',
  startsWith: 'starts with',
  endsWith: 'ends with',
  matches: 'matches regex',
  gt: 'is greater than',
  lt: 'is less than',
};

export interface ConditionsEditorProps {
  conditions: RuleCondition[];
  mode: ConditionMode;
  onChange: (conditions: RuleCondition[]) => void;
  onChangeMode: (mode: ConditionMode) => void;
}

/**
 * Url and method decide *which endpoint*; conditions decide *which call to it*.
 * "This POST, but only when the payload's role is admin" is the case that
 * cannot be expressed any other way, and it is the common one.
 */
export function ConditionsEditor({
  conditions,
  mode,
  onChange,
  onChangeMode,
}: ConditionsEditorProps) {
  const patch = (id: string, changes: Partial<RuleCondition>) => {
    onChange(
      conditions.map((condition) =>
        condition.id === id ? { ...condition, ...changes } : condition,
      ),
    );
  };

  return (
    <div className="flex flex-col gap-2.5">
      <SectionHeading>Only when</SectionHeading>

      {conditions.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-ink-muted">
          No conditions: every request matching the url and method is taken. Add one to narrow the
          rule by header, cookie, query parameter or payload.
        </p>
      ) : (
        <>
          {conditions.length > 1 ? (
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label>Match</Label>
                <Segmented
                  label="How conditions combine"
                  className="w-40"
                  value={mode}
                  onChange={onChangeMode}
                  options={CONDITION_MODE_OPTIONS}
                />
              </div>
              <p className="helper">{segmentedHint(CONDITION_MODE_OPTIONS, mode)}</p>
            </div>
          ) : null}

          <ul className="flex flex-col gap-1.5">
            {conditions.map((condition, index) => {
              const needsKey = !KEYLESS_SOURCES.has(condition.source);
              const needsValue = !VALUELESS_OPERATORS.has(condition.operator);
              const incomplete = needsKey && condition.key.trim().length === 0;

              return (
                <li
                  key={condition.id}
                  className={cn(
                    'flex flex-col gap-1.5 rounded-xl bg-surface p-2 shadow-ring',
                    !condition.enabled && 'opacity-55',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Switch
                      checked={condition.enabled}
                      onCheckedChange={(enabled) => {
                        patch(condition.id, { enabled });
                      }}
                      aria-label={`${condition.enabled ? 'Disable' : 'Enable'} condition ${String(index + 1)}`}
                    />

                    <Select
                      value={condition.source}
                      aria-label={`Condition ${String(index + 1)} source`}
                      className="h-7 w-[6.75rem] text-[12px]"
                      onChange={(event) => {
                        const source = event.target.value as ConditionSource;
                        patch(condition.id, {
                          source,
                          // A path is meaningless once the source stops taking one.
                          key: KEYLESS_SOURCES.has(source) ? '' : condition.key,
                        });
                      }}
                    >
                      {CONDITION_SOURCES.map((source) => (
                        <option key={source} value={source}>
                          {SOURCE_LABEL[source]}
                        </option>
                      ))}
                    </Select>

                    {needsKey ? (
                      <Input
                        value={condition.key}
                        aria-label={`Condition ${String(index + 1)} name`}
                        aria-invalid={incomplete}
                        placeholder={KEY_PLACEHOLDER[condition.source]}
                        autoComplete="off"
                        className="h-7 min-w-24 flex-1 font-mono text-[12px]"
                        onChange={(event) => {
                          patch(condition.id, { key: event.target.value });
                        }}
                      />
                    ) : null}

                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Remove condition ${String(index + 1)}`}
                      className="ml-auto"
                      onClick={() => {
                        onChange(conditions.filter((item) => item.id !== condition.id));
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5">
                    <Select
                      value={condition.operator}
                      aria-label={`Condition ${String(index + 1)} test`}
                      className="h-7 w-[8.5rem] text-[12px]"
                      onChange={(event) => {
                        patch(condition.id, {
                          operator: event.target.value as ConditionOperator,
                        });
                      }}
                    >
                      {CONDITION_OPERATORS.map((operator) => (
                        <option key={operator} value={operator}>
                          {OPERATOR_LABEL[operator]}
                        </option>
                      ))}
                    </Select>

                    {needsValue ? (
                      <Input
                        value={condition.value}
                        aria-label={`Condition ${String(index + 1)} value`}
                        placeholder="value"
                        autoComplete="off"
                        className="h-7 min-w-24 flex-1 font-mono text-[12px]"
                        onChange={(event) => {
                          patch(condition.id, { value: event.target.value });
                        }}
                      />
                    ) : null}

                    {needsValue ? (
                      <button
                        type="button"
                        aria-pressed={condition.caseSensitive}
                        title="Match case"
                        onClick={() => {
                          patch(condition.id, { caseSensitive: !condition.caseSensitive });
                        }}
                        className={cn(
                          'h-7 shrink-0 rounded-full border px-2 font-mono text-[11px] font-medium transition-colors',
                          condition.caseSensitive
                            ? 'border-ink bg-ink text-paper'
                            : 'border-hairline-strong text-ink-muted hover:text-ink',
                        )}
                      >
                        Aa
                      </button>
                    ) : null}
                  </div>

                  <p className="text-[11.5px] leading-snug text-ink-muted">
                    {incomplete
                      ? `Name this ${SOURCE_LABEL[condition.source].toLowerCase()} — an empty name reads as absent, so the rule will never match.`
                      : SOURCE_HINT[condition.source]}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            onChange([...conditions, createCondition('header')]);
          }}
        >
          <Plus />
          Add condition
        </Button>
      </div>
    </div>
  );
}
