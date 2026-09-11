import { checkJson, formatJson, type ResponseBody, type ResponseBodyType } from '@decoy/core';
import { ChevronDown, ChevronUp, Maximize2, Search, X } from 'lucide-react';
import { useCallback, useMemo, useRef, useState } from 'react';

import { FieldsEditor } from '@/ui/components/rule-editor/FieldsEditor';
import { Button } from '@/ui/components/ui/button';
import { Chip, ChipGroup } from '@/ui/components/ui/chip';
import { Dialog, FullscreenDialogContent } from '@/ui/components/ui/dialog';
import { Label } from '@/ui/components/ui/field';
import { FileLoader, dropRing, useFileDrop, type LoadedFile } from '@/ui/components/ui/file-loader';
import { CodeEditor } from '@/ui/components/ui/code-editor';
import { Input, Select } from '@/ui/components/ui/input';
import { useToast } from '@/ui/components/ui/toast';
import { cn } from '@/ui/lib/utils';

export interface BodyEditorProps {
  type: ResponseBodyType;
  value: string;
  onChangeType: (next: ResponseBodyType) => void;
  onChangeValue: (next: string) => void;
  /**
   * Type and value in one write. Loading a file changes both at once, and two
   * sequential patches would each be computed from the body as it was before
   * the other one -- so the type change would be lost, or the whole value with
   * it when the body had been `empty`.
   */
  onReplace: (next: ResponseBody) => void;
}

/** Every index at which `needle` occurs. Empty needle finds nothing, not everything. */
function findMatches(haystack: string, needle: string, caseSensitive: boolean): number[] {
  if (needle.length === 0) return [];
  const text = caseSensitive ? haystack : haystack.toLowerCase();
  const term = caseSensitive ? needle : needle.toLowerCase();

  const found: number[] = [];
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at === -1) break;
    found.push(at);
    // Advance by one, so overlapping occurrences are all reachable.
    from = at + 1;
  }
  return found;
}

/**
 * Puts the match on screen. `setSelectionRange` alone does not reliably scroll
 * a textarea that is already focused, so the line is computed and scrolled to
 * directly.
 */
function revealMatch(textarea: HTMLTextAreaElement, start: number, end: number): void {
  textarea.focus();
  textarea.setSelectionRange(start, end);

  const before = textarea.value.slice(0, start);
  const line = before.split('\n').length - 1;
  const lineHeight = Number.parseFloat(getComputedStyle(textarea).lineHeight) || 18;
  const target = line * lineHeight - textarea.clientHeight / 2;
  textarea.scrollTop = Math.max(0, target);
}

function BodySearch({
  textareaRef,
  value,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  value: string;
}) {
  const [query, setQuery] = useState('');
  const [caseSensitive] = useState(false);
  /** -1 means "nothing stepped to yet", so the first step lands on match one. */
  const [index, setIndex] = useState(-1);

  const matches = useMemo(
    () => findMatches(value, query, caseSensitive),
    [value, query, caseSensitive],
  );

  /*
   * A changed query means the old position is meaningless. Adjusted during
   * render rather than in an effect, which is what React recommends for state
   * derived from other state: an effect would render once with a stale index
   * and then immediately again with the right one.
   */
  const [searchedFor, setSearchedFor] = useState({ query, caseSensitive });
  if (searchedFor.query !== query || searchedFor.caseSensitive !== caseSensitive) {
    setSearchedFor({ query, caseSensitive });
    setIndex(-1);
  }

  const step = useCallback(
    (direction: 1 | -1) => {
      if (matches.length === 0) return;
      // From the unstepped state, forward lands on the first match and
      // backward on the last, rather than both landing in the middle.
      const next =
        index < 0
          ? direction === 1
            ? 0
            : matches.length - 1
          : (((index + direction) % matches.length) + matches.length) % matches.length;

      setIndex(next);
      const start = matches[next];
      const textarea = textareaRef.current;
      if (start === undefined || textarea === null) return;
      revealMatch(textarea, start, start + query.length);
    },
    [index, matches, query.length, textareaRef],
  );

  return (
    <div className="flex items-center gap-1">
      <div className="relative">
        <Search
          aria-hidden
          className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-ink-muted"
        />
        <Input
          type="search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }}
          placeholder="Find in body"
          aria-label="Find in body"
          className="h-7 w-44 pl-7 font-mono text-[12px]"
        />
      </div>

      <span
        aria-live="polite"
        className={cn(
          'tabular w-16 shrink-0 text-center font-mono text-[11px]',
          query.length > 0 && matches.length === 0 ? 'text-danger' : 'text-ink-muted',
        )}
      >
        {query.length === 0
          ? ''
          : matches.length === 0
            ? 'no match'
            : index < 0
              ? `${String(matches.length)} found`
              : `${String(index + 1)} / ${String(matches.length)}`}
      </span>

      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Previous match"
        disabled={matches.length === 0}
        onClick={() => {
          step(-1);
        }}
      >
        <ChevronUp />
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Next match"
        disabled={matches.length === 0}
        onClick={() => {
          step(1);
        }}
      >
        <ChevronDown />
      </Button>
      {query.length > 0 ? (
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label="Clear search"
          onClick={() => {
            setQuery('');
          }}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

export function BodyEditor({
  type,
  value,
  onChangeType,
  onChangeValue,
  onReplace,
}: BodyEditorProps) {
  const toast = useToast();
  const [expanded, setExpanded] = useState(false);
  /**
   * Raw by default. Fields are the friendlier way in, but the textarea is what
   * this control has always been, and a body that silently opened in a
   * different editor than the one you left it in is worse than one extra click.
   */
  const [view, setView] = useState<'raw' | 'fields'>('raw');
  const inlineRef = useRef<HTMLTextAreaElement>(null);
  const fullRef = useRef<HTMLTextAreaElement>(null);

  const check = useMemo(() => (type === 'json' ? checkJson(value) : null), [type, value]);
  const jsonError = check !== null && !check.valid ? check.error : null;

  const lineCount = useMemo(() => value.split('\n').length, [value]);

  /**
   * A fixture file becomes the body. The type follows the file rather than the
   * control: a dropped `.json` file that lands in a `text` body would lose its
   * Content-Type and its formatting, which is not what dropping it meant.
   *
   * Undoable, because it replaces whatever was there.
   */
  const loadFile = (file: LoadedFile) => {
    const previous: ResponseBody = type === 'empty' ? { type: 'empty' } : { type, value };
    const nextType: ResponseBodyType = checkJson(file.text).valid ? 'json' : 'text';
    onReplace({ type: nextType, value: file.text });
    toast.show(`Body loaded from ${file.name} as ${nextType}`, {
      label: 'Undo',
      onAct: () => {
        onReplace(previous);
      },
    });
  };

  const drop = useFileDrop(loadFile, (message) => {
    toast.show(message);
  });

  const fileLoader = (
    <FileLoader
      onLoad={loadFile}
      onError={(message) => {
        toast.show(message);
      }}
      accept=".json,.txt,.html,.xml,.csv,.log,text/*,application/json"
    />
  );

  const typeAndFormat = (
    <div className="flex items-center gap-1">
      <Select
        value={type}
        aria-label="Body type"
        className="h-6 w-[5.5rem] px-2 text-[12px]"
        onChange={(event) => {
          onChangeType(event.target.value as ResponseBodyType);
        }}
      >
        <option value="json">json</option>
        <option value="text">text</option>
        <option value="empty">empty</option>
      </Select>
      {type === 'json' ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            onChangeValue(formatJson(value));
          }}
        >
          Format
        </Button>
      ) : null}
    </div>
  );

  if (type === 'empty') {
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Label>Response body</Label>
          <div className="flex items-center gap-1">
            {typeAndFormat}
            {fileLoader}
          </div>
        </div>
        <p
          {...drop.handlers}
          className={cn(
            'rounded-lg px-1 text-[12px] leading-snug text-ink-muted',
            dropRing(drop.over),
          )}
        >
          No body is sent, and no Content-Type is set. Drop a file here, or load one, to answer with
          its contents instead.
        </p>
      </div>
    );
  }

  const placeholder = type === 'json' ? '{\n  "error": "not found"\n}' : 'Plain text';
  const showFields = type === 'json' && view === 'fields';

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2.5">
          <Label htmlFor={showFields ? undefined : 'decoy-body'}>Response body</Label>
          {/* Only for json. There are no fields in a plain-text body, and a
              disabled toggle sitting there would imply otherwise. */}
          {type === 'json' ? (
            <ChipGroup label="Body editor" className="gap-1">
              <Chip
                selected={view === 'fields'}
                onClick={() => {
                  setView('fields');
                }}
              >
                fields
              </Chip>
              <Chip
                selected={view === 'raw'}
                onClick={() => {
                  setView('raw');
                }}
              >
                raw
              </Chip>
            </ChipGroup>
          ) : null}
        </div>
        <div className="flex items-center gap-1">
          {typeAndFormat}
          {fileLoader}
          <Button
            size="sm"
            variant="secondary"
            aria-label="Edit the body full screen"
            onClick={() => {
              setExpanded(true);
            }}
          >
            <Maximize2 />
            Expand
          </Button>
        </div>
      </div>

      {/* Wrapped so the drop handlers sit outside the textarea. Left on the
          textarea itself, the browser's own file-drop behaviour would win and
          navigate the surface to the file, taking the rule with it. */}
      <div {...drop.handlers} className={cn('flex flex-col rounded-lg', dropRing(drop.over))}>
        {showFields ? (
          <FieldsEditor value={value} onChange={onChangeValue} />
        ) : (
          <CodeEditor
            id="decoy-body"
            ref={inlineRef}
            rows={8}
            language={type === 'json' ? 'json' : 'none'}
            value={value}
            onValueChange={onChangeValue}
            aria-invalid={jsonError !== null}
            aria-label="Response body"
            placeholder={placeholder}
          />
        )}
      </div>

      {jsonError !== null && !showFields ? (
        // Not blocking: an unparseable body is itself a case worth mocking.
        <p className="text-[12px] leading-snug text-ink-muted">
          Not valid JSON ({jsonError}). It will be sent exactly as written.
        </p>
      ) : null}

      <Dialog open={expanded} onOpenChange={setExpanded}>
        {expanded ? (
          <FullscreenDialogContent
            title="Response body"
            toolbar={
              <div className="flex flex-1 flex-wrap items-center gap-2">
                {typeAndFormat}
                <BodySearch textareaRef={fullRef} value={value} />
              </div>
            }
            footer={
              <>
                <span className="eyebrow tabular">
                  {String(lineCount)} lines · {String(value.length)} chars
                </span>
                {jsonError !== null ? (
                  <span className="text-[12px] text-warn">Not valid JSON ({jsonError})</span>
                ) : type === 'json' && value.trim().length > 0 ? (
                  <span className="text-[12px] text-ok">Valid JSON</span>
                ) : null}
                <Button
                  size="sm"
                  variant="primary"
                  className="ml-auto"
                  onClick={() => {
                    setExpanded(false);
                  }}
                >
                  Done
                </Button>
              </>
            }
          >
            {/* The editor owns the whole dialog body; the outer form still
                holds the value, so closing loses nothing. */}
            <CodeEditor
              ref={fullRef}
              value={value}
              onValueChange={onChangeValue}
              language={type === 'json' ? 'json' : 'none'}
              aria-label="Response body"
              placeholder={placeholder}
              className="min-h-0 flex-1 rounded-none bg-paper shadow-none focus-within:shadow-none"
            />
          </FullscreenDialogContent>
        ) : null}
      </Dialog>
    </div>
  );
}
