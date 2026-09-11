import {
  NETWORK_ERROR_TYPES,
  URL_MATCH_MODES,
  checkJson,
  createNetworkErrorAction,
  createRespondAction,
  formatJson,
  isValidRegExp,
  type MockRule,
  type NetworkErrorType,
  type ResponseBodyType,
  type RuleAction,
  type RuleActionKind,
  type UrlMatchMode,
} from '@mocksmith/core';
import { ArrowLeft, RotateCcw, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';

import { HeadersEditor } from '@/ui/components/rule-editor/HeadersEditor';
import { MethodPicker } from '@/ui/components/rule-editor/MethodPicker';
import { StatusPicker } from '@/ui/components/rule-editor/StatusPicker';
import { UrlMatchTester } from '@/ui/components/rule-editor/UrlMatchTester';
import { Button } from '@/ui/components/ui/button';
import { Field, Label, SectionHeading } from '@/ui/components/ui/field';
import { Input, Select, Textarea } from '@/ui/components/ui/input';
import { Pill } from '@/ui/components/ui/pill';
import { Segmented } from '@/ui/components/ui/segmented';

const MODE_HINTS: Record<UrlMatchMode, string> = {
  contains: 'Matches when the url contains this text anywhere.',
  equals: 'Matches only the exact, complete url.',
  startsWith: 'Matches from the start of the full url, including the scheme.',
  endsWith: 'Matches the end of the url, query string included.',
  wildcard: 'Anchored pattern. * is any run of characters, ? is exactly one.',
  regex: 'Unanchored JavaScript regular expression.',
};

const ACTION_OPTIONS = [
  { value: 'respond' as const, label: 'Respond', hint: 'Return a synthesized response' },
  { value: 'networkError' as const, label: 'Fail', hint: 'Make the request fail or hang' },
  { value: 'passthrough' as const, label: 'Pass through', hint: 'Let this one reach the network' },
];

const ERROR_HINTS: Record<NetworkErrorType, string> = {
  failed: 'Rejects like a DNS failure or a CORS block.',
  timeout: 'Never responds, so the caller’s own timeout has to handle it.',
  aborted: 'Rejects with an AbortError.',
};

export interface RuleEditorProps {
  rule: MockRule;
  onSave: (rule: MockRule) => void;
  onDelete: () => void;
  /** Supplied by the popup, which drills down instead of splitting the view. */
  onBack?: () => void;
}

export function RuleEditor({ rule, onSave, onDelete, onBack }: RuleEditorProps) {
  const [draft, setDraft] = useState<MockRule>(rule);
  const [draftRuleId, setDraftRuleId] = useState(rule.id);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Adjusting state during render, rather than in an effect, so switching rules
  // never paints one rule's values under another rule's heading.
  if (draftRuleId !== rule.id) {
    setDraftRuleId(rule.id);
    setDraft(rule);
    setConfirmingDelete(false);
  }

  const isDirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(rule), [draft, rule]);

  const urlError = useMemo(() => {
    const { mode, value } = draft.matcher.url;
    if (value.trim().length === 0) return 'A url pattern is required.';
    if (mode === 'regex' && !isValidRegExp(value)) return 'Not a valid regular expression.';
    return null;
  }, [draft.matcher.url]);

  const bodyCheck = useMemo(() => {
    if (draft.action.kind !== 'respond') return null;
    if (draft.action.body.type !== 'json') return null;
    return checkJson(draft.action.body.value);
  }, [draft.action]);

  const patchDraft = (patch: Partial<MockRule>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const patchRespond = (patch: Partial<Extract<RuleAction, { kind: 'respond' }>>) => {
    setDraft((current) =>
      current.action.kind === 'respond'
        ? { ...current, action: { ...current.action, ...patch } }
        : current,
    );
  };

  const changeActionKind = (kind: RuleActionKind) => {
    setDraft((current) => {
      if (current.action.kind === kind) return current;
      const delayMs = current.action.kind === 'passthrough' ? 0 : current.action.delayMs;
      if (kind === 'respond') {
        return { ...current, action: { ...createRespondAction(404), delayMs } };
      }
      if (kind === 'networkError') {
        return { ...current, action: { ...createNetworkErrorAction('failed'), delayMs } };
      }
      return { ...current, action: { kind: 'passthrough' } };
    });
  };

  const canSave = isDirty && urlError === null;

  return (
    <form
      className="flex h-full min-h-0 flex-col bg-paper"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave(draft);
      }}
    >
      <header className="flex items-center gap-1.5 border-b border-hairline bg-surface px-2.5 py-2">
        {onBack !== undefined ? (
          <Button size="icon-sm" variant="ghost" onClick={onBack} aria-label="Back to rules">
            <ArrowLeft />
          </Button>
        ) : null}

        {/* The name is the heading. A separate labelled field below would just
            repeat it back to the user. */}
        <input
          value={draft.name}
          onChange={(event) => {
            patchDraft({ name: event.target.value });
          }}
          aria-label="Rule name"
          placeholder="Untitled rule"
          autoComplete="off"
          className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 text-[15px] font-semibold tracking-[-0.015em] text-ink placeholder:font-normal placeholder:text-ink-faint hover:bg-sunk focus:bg-sunk focus:outline-none"
        />

        {isDirty ? <Pill className="border-gold/50 bg-wash text-warn">unsaved</Pill> : null}
        <Button
          size="icon-sm"
          variant="ghost"
          disabled={!isDirty}
          aria-label="Revert unsaved changes"
          title="Revert"
          onClick={() => {
            setDraft(rule);
          }}
        >
          <RotateCcw />
        </Button>
        <Button size="sm" variant="primary" type="submit" disabled={!canSave}>
          Save
        </Button>
      </header>

      {/* Capped to a readable measure: a form stretched across a 1400px pane
          reads as a stretched form, not a spacious one. */}
      <div className="flex min-h-0 w-full max-w-3xl flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <SectionHeading>When</SectionHeading>

        <Field label="Request url" hint={MODE_HINTS[draft.matcher.url.mode]} error={urlError}>
          {(id) => (
            <div className="flex gap-1.5">
              <Select
                value={draft.matcher.url.mode}
                aria-label="Url match mode"
                className="w-[7.5rem]"
                onChange={(event) => {
                  patchDraft({
                    matcher: {
                      ...draft.matcher,
                      url: { ...draft.matcher.url, mode: event.target.value as UrlMatchMode },
                    },
                  });
                }}
              >
                {URL_MATCH_MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {mode}
                  </option>
                ))}
              </Select>
              <Input
                id={id}
                value={draft.matcher.url.value}
                aria-invalid={urlError !== null}
                onChange={(event) => {
                  patchDraft({
                    matcher: {
                      ...draft.matcher,
                      url: { ...draft.matcher.url, value: event.target.value },
                    },
                  });
                }}
                placeholder="/api/users"
                className="font-mono text-xs"
                autoComplete="off"
              />
            </div>
          )}
        </Field>

        <UrlMatchTester matcher={draft.matcher.url} />

        <div className="flex flex-col gap-1.5">
          <Label>Methods</Label>
          <MethodPicker
            value={draft.matcher.methods}
            onChange={(methods) => {
              patchDraft({ matcher: { ...draft.matcher, methods } });
            }}
          />
        </div>

        <SectionHeading>Then</SectionHeading>

        <Segmented
          label="Rule action"
          options={ACTION_OPTIONS}
          value={draft.action.kind}
          onChange={changeActionKind}
          className="max-w-96"
        />

        {draft.action.kind === 'respond' ? (
          <RespondFields
            action={draft.action}
            bodyError={bodyCheck !== null && !bodyCheck.valid ? bodyCheck.error : null}
            onPatch={patchRespond}
          />
        ) : null}

        {draft.action.kind === 'networkError' ? (
          <div className="flex gap-2.5">
            <Field label="Failure" hint={ERROR_HINTS[draft.action.errorType]} className="flex-1">
              {(id) => (
                <Select
                  id={id}
                  value={draft.action.kind === 'networkError' ? draft.action.errorType : 'failed'}
                  onChange={(event) => {
                    setDraft((current) =>
                      current.action.kind === 'networkError'
                        ? {
                            ...current,
                            action: {
                              ...current.action,
                              errorType: event.target.value as NetworkErrorType,
                            },
                          }
                        : current,
                    );
                  }}
                >
                  {NETWORK_ERROR_TYPES.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <DelayField
              value={draft.action.delayMs}
              onChange={(delayMs) => {
                setDraft((current) =>
                  current.action.kind === 'networkError'
                    ? { ...current, action: { ...current.action, delayMs } }
                    : current,
                );
              }}
            />
          </div>
        ) : null}

        {draft.action.kind === 'passthrough' ? (
          <p className="rounded-xl bg-surface p-2.5 text-[11px] leading-relaxed text-ink-muted shadow-ring">
            Matching requests reach the real network. Place this above a broader rule to carve out
            an exception.
          </p>
        ) : null}
      </div>

      <footer className="flex items-center justify-between gap-2 border-t border-hairline bg-surface px-3.5 py-2">
        <span className="font-mono text-[10px] text-ink-faint">{draft.id}</span>
        {confirmingDelete ? (
          <div className="flex items-center gap-1.5">
            <span className="text-[11px] text-ink-muted">Delete this rule?</span>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setConfirmingDelete(false);
              }}
            >
              Cancel
            </Button>
            <Button size="sm" variant="danger" onClick={onDelete}>
              Delete
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setConfirmingDelete(true);
            }}
          >
            <Trash2 />
            Delete
          </Button>
        )}
      </footer>
    </form>
  );
}

function DelayField({ value, onChange }: { value: number; onChange: (next: number) => void }) {
  return (
    <Field label="Delay (ms)" className="w-24">
      {(id) => (
        <Input
          id={id}
          type="number"
          min={0}
          value={value}
          onChange={(event) => {
            const parsed = Number.parseInt(event.target.value, 10);
            onChange(Number.isNaN(parsed) ? 0 : Math.max(0, parsed));
          }}
          className="font-mono tabular"
        />
      )}
    </Field>
  );
}

interface RespondFieldsProps {
  action: Extract<RuleAction, { kind: 'respond' }>;
  bodyError: string | null;
  onPatch: (patch: Partial<Extract<RuleAction, { kind: 'respond' }>>) => void;
}

function RespondFields({ action, bodyError, onPatch }: RespondFieldsProps) {
  const bodyType = action.body.type;
  const bodyValue = action.body.type === 'empty' ? '' : action.body.value;

  return (
    <>
      <div className="flex gap-2.5">
        <Field label="Status" className="flex-1">
          {(id) => (
            <StatusPicker
              controlId={id}
              value={action.status}
              onChange={(status) => {
                onPatch({ status });
              }}
            />
          )}
        </Field>
        <DelayField
          value={action.delayMs}
          onChange={(delayMs) => {
            onPatch({ delayMs });
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="mocksmith-body">Response body</Label>
          <div className="flex items-center gap-1">
            <Select
              value={bodyType}
              aria-label="Body type"
              className="h-6 w-[4.75rem] text-[11px]"
              onChange={(event) => {
                const nextType = event.target.value as ResponseBodyType;
                onPatch({
                  body:
                    nextType === 'empty' ? { type: 'empty' } : { type: nextType, value: bodyValue },
                });
              }}
            >
              <option value="json">json</option>
              <option value="text">text</option>
              <option value="empty">empty</option>
            </Select>
            {bodyType === 'json' ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  onPatch({ body: { type: 'json', value: formatJson(bodyValue) } });
                }}
              >
                Format
              </Button>
            ) : null}
          </div>
        </div>

        {bodyType === 'empty' ? (
          <p className="text-[11px] leading-snug text-ink-muted">
            No body is sent, and no Content-Type is set.
          </p>
        ) : (
          <>
            <Textarea
              id="mocksmith-body"
              rows={8}
              value={bodyValue}
              aria-invalid={bodyError !== null}
              onChange={(event) => {
                onPatch({ body: { type: bodyType, value: event.target.value } });
              }}
              placeholder={bodyType === 'json' ? '{\n  "error": "not found"\n}' : 'Plain text'}
            />
            {bodyError !== null ? (
              // Not blocking: an unparseable body is itself a case worth mocking.
              <p className="text-[11px] leading-snug text-ink-muted">
                Not valid JSON ({bodyError}). It will be sent exactly as written.
              </p>
            ) : null}
          </>
        )}
      </div>

      <HeadersEditor
        headers={action.headers}
        onChange={(headers) => {
          onPatch({ headers });
        }}
      />
    </>
  );
}
