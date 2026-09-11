import {
  NETWORK_ERROR_TYPES,
  URL_MATCH_MODES,
  createHandlerAction,
  applyRuleEdits,
  createNetworkErrorAction,
  createRespondAction,
  createStreamAction,
  isValidRegExp,
  ruleEditsEqual,
  type ConditionMode,
  type MockRule,
  type NetworkErrorType,
  type ResponseBodyType,
  type RuleAction,
  type RuleActionKind,
  type RuleCondition,
  type StreamChunk,
  type StreamFormat,
  type UrlMatchMode,
} from '@mocksmith/core';
import { ArrowLeft, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';

import { BodyEditor } from '@/ui/components/rule-editor/BodyEditor';
import { ConditionsEditor } from '@/ui/components/rule-editor/ConditionsEditor';
import { HandlerEditor } from '@/ui/components/rule-editor/HandlerEditor';
import { HeadersEditor } from '@/ui/components/rule-editor/HeadersEditor';
import { MethodPicker } from '@/ui/components/rule-editor/MethodPicker';
import { StatusPicker } from '@/ui/components/rule-editor/StatusPicker';
import { StreamEditor } from '@/ui/components/rule-editor/StreamEditor';
import { Button } from '@/ui/components/ui/button';
import { Field, Label, SectionHeading } from '@/ui/components/ui/field';
import { HelpPopover } from '@/ui/components/ui/help-popover';
import { Input, Select } from '@/ui/components/ui/input';
import { Listbox, type ListboxOption } from '@/ui/components/ui/listbox';
import { Segmented, segmentedHint, type SegmentedOption } from '@/ui/components/ui/segmented';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { getShortcutRoot } from '@/ui/lib/roots';
import { UrlMatchTester } from '@/ui/components/rule-editor/UrlMatchTester';
import { cn } from '@/ui/lib/utils';

/**
 * The six modes decide whether a rule ever fires, so their descriptions belong
 * at the moment of choosing rather than under a different field afterwards.
 * The short line goes in the listbox; the long one goes under the control.
 *
 * Keyed by mode and then mapped over `URL_MATCH_MODES`, so adding a mode to the
 * engine without describing it here is a type error rather than a silently
 * undescribed option.
 */
const MODE_DESCRIPTIONS: Record<UrlMatchMode, ReactNode> = {
  contains: 'The url contains this text anywhere',
  equals: 'The exact, complete url',
  startsWith: 'From the start, scheme included',
  endsWith: 'The end of the url, query included',
  wildcard: (
    <>
      Anchored. <code>*</code> any run, <code>?</code> exactly one
    </>
  ),
  regex: 'Unanchored JavaScript expression',
};

const MODE_OPTIONS: Array<ListboxOption<UrlMatchMode>> = URL_MATCH_MODES.map((value) => ({
  value,
  label: value,
  description: MODE_DESCRIPTIONS[value],
}));

const MODE_HINTS: Record<UrlMatchMode, string> = {
  contains: 'Matches when the url contains this text anywhere. A path or a full url both work.',
  equals: 'Matches the whole url. Leaving off https:// is fine — the scheme is then ignored.',
  startsWith:
    'Matches from the start of the url. Leaving off https:// is fine; a bare path is not.',
  endsWith: 'Matches the end of the url, query string included.',
  wildcard: 'Anchored pattern. * is any run of characters, ? is exactly one. Scheme optional.',
  regex: 'Unanchored JavaScript regular expression, tested against the full url including scheme.',
};

const ACTION_OPTIONS: Array<SegmentedOption<RuleActionKind>> = [
  {
    value: 'respond',
    label: 'Respond',
    hint: 'Return a synthesized response with a status, body and headers.',
  },
  {
    value: 'stream',
    label: 'Stream',
    hint: 'Return a response whose body arrives in pieces, over time, instead of all at once.',
  },
  {
    value: 'handler',
    label: 'Handler',
    hint: 'Answer with JavaScript you write: the response can depend on the method, query, headers, cookies or payload, and on what happened on earlier calls.',
  },
  {
    value: 'networkError',
    label: 'Fail',
    hint: 'Make the request fail or hang, the way a broken network would.',
  },
  {
    value: 'passthrough',
    label: 'Pass through',
    hint: 'Let matching requests reach the real network. Place this above a broader rule to carve out an exception.',
  },
];

const ERROR_HINTS: Record<NetworkErrorType, string> = {
  failed: 'Rejects like a DNS failure or a CORS block.',
  timeout: 'Never responds, so the caller’s own timeout has to handle it.',
  aborted: 'Rejects with an AbortError.',
};

export interface RuleEditorProps {
  rule: MockRule;
  /** The whole list, so the match tester can answer "which rule wins?". */
  rules: MockRule[];
  onSave: (rule: MockRule) => void;
  onDelete: () => void;
  /** Supplied by the popup, which drills down instead of splitting the view. */
  onBack?: () => void;
  /** Lets the parent render the preview pane from the in-progress draft. */
  onDraftChange?: (draft: MockRule) => void;
  /**
   * The tester lives here on narrow surfaces and in the preview pane on wide
   * ones. It is the strongest explanatory device in the product, so exactly one
   * copy of it is always on screen.
   */
  showMatchTester?: boolean;
}

export function RuleEditor({
  rule,
  rules,
  onSave,
  onDelete,
  onBack,
  onDraftChange,
  showMatchTester = false,
}: RuleEditorProps) {
  const [draft, setDraft] = useState<MockRule>(rule);
  const [draftRuleId, setDraftRuleId] = useState(rule.id);

  // Adjusting state during render, rather than in an effect, so switching rules
  // never paints one rule's values under another rule's heading.
  if (draftRuleId !== rule.id) {
    setDraftRuleId(rule.id);
    setDraft(rule);
  }

  // Only the fields this form owns. Comparing the whole rule would count the
  // `updatedAt` that saving stamps, and the switch the list owns, as edits.
  const isDirty = useMemo(() => !ruleEditsEqual(draft, rule), [draft, rule]);

  const urlError = useMemo(() => {
    const { mode, value } = draft.matcher.url;
    if (value.trim().length === 0) return 'A url pattern is required.';
    if (mode === 'regex' && !isValidRegExp(value)) return 'Not a valid regular expression.';
    return null;
  }, [draft.matcher.url]);

  const canSave = isDirty && urlError === null;

  useEffect(() => {
    onDraftChange?.(draft);
  }, [draft, onDraftChange]);

  // The form applies on save while the toggles apply instantly, which is the
  // right split -- a half-typed pattern must not hijack traffic -- but it only
  // works if the fast path is there. A greyed-out button is not a fast path.
  useEffect(() => {
    if (!canSave) return;
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) return;
      if (event.key !== 's' || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      onSave(applyRuleEdits(rule, draft));
    };
    // The surface, not `window`: in the floating panel this would otherwise
    // take ⌘S away from the page being debugged.
    const root = getShortcutRoot();
    root.addEventListener('keydown', onKeyDown);
    return () => {
      root.removeEventListener('keydown', onKeyDown);
    };
  }, [canSave, draft, rule, onSave]);

  const patchDraft = (patch: Partial<MockRule>) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const patchUrl = (patch: Partial<MockRule['matcher']['url']>) => {
    setDraft((current) => ({
      ...current,
      matcher: { ...current.matcher, url: { ...current.matcher.url, ...patch } },
    }));
  };

  const patchRespond = (patch: Partial<Extract<RuleAction, { kind: 'respond' }>>) => {
    setDraft((current) =>
      current.action.kind === 'respond'
        ? { ...current, action: { ...current.action, ...patch } }
        : current,
    );
  };

  const patchStream = (patch: Partial<Extract<RuleAction, { kind: 'stream' }>>) => {
    setDraft((current) =>
      current.action.kind === 'stream'
        ? { ...current, action: { ...current.action, ...patch } }
        : current,
    );
  };

  const patchHandler = (patch: Partial<Extract<RuleAction, { kind: 'handler' }>>) => {
    setDraft((current) =>
      current.action.kind === 'handler'
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
      if (kind === 'stream') {
        return { ...current, action: { ...createStreamAction(), delayMs } };
      }
      if (kind === 'handler') {
        // Keeping the code across a switch away and back is deliberate: losing
        // a handler you spent ten minutes on because you clicked the wrong
        // segment is unforgivable, and `current.action.code` is still there.
        const code = current.action.kind === 'handler' ? current.action.code : undefined;
        return { ...current, action: { ...createHandlerAction(code), delayMs } };
      }
      if (kind === 'networkError') {
        return { ...current, action: { ...createNetworkErrorAction('failed'), delayMs } };
      }
      return { ...current, action: { kind: 'passthrough' } };
    });
  };

  const mode = draft.matcher.url.mode;
  const needsSyntaxHelp = mode === 'wildcard' || mode === 'regex';

  return (
    <form
      className="flex h-full min-h-0 flex-col bg-paper"
      onSubmit={(event) => {
        event.preventDefault();
        if (canSave) onSave(applyRuleEdits(rule, draft));
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
          className="min-w-0 flex-1 rounded-md bg-transparent px-1.5 py-0.5 text-[16.5px] font-semibold tracking-[-0.015em] text-ink placeholder:font-normal placeholder:text-ink-label hover:bg-sunk focus:bg-sunk focus:outline-none"
        />

        {/* Both were in a footer. They belong up here beside the name: the id
            is what you copy when talking about a rule, and Delete is the one
            action you should not have to scroll a long form to reach. */}
        <span className="hidden shrink-0 font-mono text-[11px] text-ink-label lg:inline">
          {draft.id}
        </span>

        <Button
          size="sm"
          variant="secondary"
          disabled={!isDirty}
          onClick={() => {
            setDraft(rule);
          }}
        >
          Discard
        </Button>
        {/* The enabled state *is* the "unsaved changes" signal. A banner saying
            the same thing costs a row of height every time you type a
            character, which moves the whole form under your cursor. */}
        <Button size="sm" variant="primary" type="submit" disabled={!canSave}>
          Save
        </Button>
        <Tooltip label="Delete this rule">
          <Button size="icon-sm" variant="ghost" onClick={onDelete} aria-label="Delete this rule">
            <Trash2 />
          </Button>
        </Tooltip>
      </header>

      {/* The full pane. It was capped to a readable measure, which left a
          third of a wide window empty next to the one control that always
          wants more room -- the body. Prose is capped individually instead, at
          its own measure, so the paragraphs stay readable while the url
          pattern, the json body and the chunk list get everything going. */}
      <div className="flex min-h-0 w-full flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <SectionHeading>When</SectionHeading>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="decoy-url-value">Request url</Label>
            {needsSyntaxHelp ? (
              <HelpPopover title="Wildcard and regex syntax" side="bottom">
                <p>
                  <b>wildcard</b> is anchored: the pattern has to describe the whole url.{' '}
                  <code>*</code> stands for any run of characters, <code>?</code> for exactly one.
                </p>
                <p>
                  <code>*/api/users*</code> matches any host and any query string.
                </p>
                <p>
                  <b>regex</b> is an unanchored JavaScript expression tested against the full url,
                  scheme included. Add <code>^</code> and <code>$</code> yourself if you want it
                  anchored.
                </p>
                <p>
                  Both modes ignore case unless the rule says otherwise, and an invalid pattern
                  never matches rather than matching everything.
                </p>
              </HelpPopover>
            ) : null}
          </div>

          {/* Method, match mode, pattern -- in that order, because that is the
              order a request line is read in. Wraps rather than shrinks: on a
              narrow pane the url drops to its own line at full width, which is
              the field that needs the room. */}
          <div className="flex flex-wrap gap-1.5">
            <MethodPicker
              value={draft.matcher.methods}
              onChange={(methods) => {
                patchDraft({ matcher: { ...draft.matcher, methods } });
              }}
              className="w-[6.25rem]"
            />
            <Listbox
              value={mode}
              options={MODE_OPTIONS}
              onChange={(next) => {
                patchUrl({ mode: next });
              }}
              ariaLabel="Url match mode"
              className="w-[8.5rem] shrink-0"
            />
            <Input
              id="decoy-url-value"
              value={draft.matcher.url.value}
              aria-invalid={urlError !== null}
              onChange={(event) => {
                patchUrl({ value: event.target.value });
              }}
              placeholder="/api/users"
              className="min-w-[12rem] flex-1 font-mono text-[13px]"
              autoComplete="off"
            />
          </div>

          <p
            className={cn(
              urlError === null ? 'helper max-w-[62ch]' : 'text-[12.5px] leading-snug text-danger',
            )}
            role={urlError === null ? undefined : 'alert'}
          >
            {urlError ?? MODE_HINTS[mode]}
          </p>
        </div>

        {showMatchTester ? <UrlMatchTester rule={draft} rules={rules} /> : null}

        <ConditionsEditor
          conditions={draft.matcher.conditions}
          mode={draft.matcher.conditionMode}
          onChange={(conditions: RuleCondition[]) => {
            patchDraft({ matcher: { ...draft.matcher, conditions } });
          }}
          onChangeMode={(conditionMode: ConditionMode) => {
            patchDraft({ matcher: { ...draft.matcher, conditionMode } });
          }}
        />

        <SectionHeading>Then</SectionHeading>

        <div className="flex flex-col gap-1.5">
          <Segmented
            label="Rule action"
            options={ACTION_OPTIONS}
            value={draft.action.kind}
            onChange={changeActionKind}
            className="max-w-[30rem]"
          />
          {/* Under the control and changing with the selection. These used to
              live in `title`, where they were effectively invisible. */}
          <p className="helper max-w-[52ch]">{segmentedHint(ACTION_OPTIONS, draft.action.kind)}</p>
        </div>

        {draft.action.kind === 'respond' ? (
          <RespondFields action={draft.action} onPatch={patchRespond} />
        ) : null}

        {draft.action.kind === 'stream' ? (
          <StreamFields action={draft.action} onPatch={patchStream} />
        ) : null}

        {draft.action.kind === 'handler' ? (
          <HandlerFields
            rule={draft}
            action={draft.action}
            onPatch={patchHandler}
            onChangeDelay={(delayMs) => {
              patchHandler({ delayMs });
            }}
          />
        ) : null}

        {draft.action.kind === 'networkError' ? (
          <div className="flex gap-2.5">
            <Field
              label="Failure"
              hint={ERROR_HINTS[draft.action.errorType]}
              className="max-w-[24rem] flex-1"
            >
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
      </div>
    </form>
  );
}

function DelayField({
  value,
  onChange,
  label = 'Delay (ms)',
}: {
  value: number;
  onChange: (next: number) => void;
  label?: string;
}) {
  return (
    <Field label={label} className="w-[7.5rem] shrink-0">
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
          className="tabular font-mono"
        />
      )}
    </Field>
  );
}

interface StreamFieldsProps {
  action: Extract<RuleAction, { kind: 'stream' }>;
  onPatch: (patch: Partial<Extract<RuleAction, { kind: 'stream' }>>) => void;
}

function StreamFields({ action, onPatch }: StreamFieldsProps) {
  return (
    <>
      <div className="flex gap-2.5">
        <Field label="Status" className="max-w-[24rem] flex-1">
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
        {/* Named for what it delays here: the head, not the whole body. The
            chunks have their own interval. */}
        <DelayField
          label="Head delay (ms)"
          value={action.delayMs}
          onChange={(delayMs) => {
            onPatch({ delayMs });
          }}
        />
      </div>

      <StreamEditor
        format={action.format}
        chunks={action.chunks}
        intervalMs={action.intervalMs}
        repeat={action.repeat}
        onChangeFormat={(format: StreamFormat) => {
          onPatch({ format });
        }}
        onChangeChunks={(chunks: StreamChunk[]) => {
          onPatch({ chunks });
        }}
        onChangeInterval={(intervalMs) => {
          onPatch({ intervalMs });
        }}
        onChangeRepeat={(repeat) => {
          onPatch({ repeat });
        }}
      />

      <HeadersEditor
        headers={action.headers}
        onChange={(headers) => {
          onPatch({ headers });
        }}
      />
    </>
  );
}

interface HandlerFieldsProps {
  /** The draft rule: a test run has to use the code on screen, not the saved one. */
  rule: MockRule;
  action: Extract<RuleAction, { kind: 'handler' }>;
  onPatch: (patch: Partial<Extract<RuleAction, { kind: 'handler' }>>) => void;
  onChangeDelay: (next: number) => void;
}

function HandlerFields({ rule, action, onPatch, onChangeDelay }: HandlerFieldsProps) {
  return (
    <>
      <HandlerEditor
        rule={rule}
        code={action.code}
        timeoutMs={action.timeoutMs}
        onChangeCode={(code) => {
          onPatch({ code });
        }}
        onChangeTimeout={(timeoutMs) => {
          onPatch({ timeoutMs });
        }}
      />
      <DelayField label="Delay (ms)" value={action.delayMs} onChange={onChangeDelay} />
    </>
  );
}

interface RespondFieldsProps {
  action: Extract<RuleAction, { kind: 'respond' }>;
  onPatch: (patch: Partial<Extract<RuleAction, { kind: 'respond' }>>) => void;
}

function RespondFields({ action, onPatch }: RespondFieldsProps) {
  const bodyValue = action.body.type === 'empty' ? '' : action.body.value;

  return (
    <>
      <div className="flex gap-2.5">
        <Field label="Status" className="max-w-[24rem] flex-1">
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

      <BodyEditor
        type={action.body.type}
        value={bodyValue}
        onChangeType={(nextType: ResponseBodyType) => {
          onPatch({
            body: nextType === 'empty' ? { type: 'empty' } : { type: nextType, value: bodyValue },
          });
        }}
        onChangeValue={(next: string) => {
          if (action.body.type === 'empty') return;
          onPatch({ body: { type: action.body.type, value: next } });
        }}
        onReplace={(body) => {
          onPatch({ body });
        }}
      />

      <HeadersEditor
        headers={action.headers}
        onChange={(headers) => {
          onPatch({ headers });
        }}
      />
    </>
  );
}
