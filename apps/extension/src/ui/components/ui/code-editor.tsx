import { useLayoutEffect, useMemo, useRef, type ComponentProps } from 'react';

import { tokenize, type CodeLanguage, type TokenKind } from '@/ui/lib/highlight';
import { cn } from '@/ui/lib/utils';

/**
 * A textarea with the code coloured behind it.
 *
 * The technique is a coloured layer rendered under a textarea whose own text is
 * transparent. It looks like a trick and it is the reason everything else still
 * works: this is a real `<textarea>`, so undo, selection, autocomplete-off,
 * spellcheck-off, drag-and-drop of a file, "find in body", every aria
 * attribute and every keyboard convention on three platforms are the ones the
 * browser already implements. A custom editor built from divs would have to
 * re-implement all of it, and would get some of it wrong.
 *
 * Two details keep the layers in register, and both are load-bearing:
 *
 *  - **Neither layer wraps.** Long lines scroll horizontally instead. Wrapping
 *    would have to agree between a textarea and a `<pre>` to the pixel, and it
 *    stops agreeing the moment a vertical scrollbar narrows one of them. Code
 *    editors do not wrap anyway.
 *  - **Every character is emitted exactly once** by the tokenizer, and both
 *    layers use identical typography and padding. Drop one character and the
 *    rest of the file slides out from under the caret.
 */

const TOKEN_CLASS: Record<TokenKind, string> = {
  // Gold for the thing being named: an object key, or one of the four values a
  // handler is handed. Both answer "what is in scope here?".
  key: 'text-gold-text',
  string: 'text-ok',
  number: 'text-warn',
  keyword: 'text-info',
  comment: 'text-ink-label',
  punctuation: 'text-ink-muted',
  plain: '',
};

/**
 * Shared by both layers. Any difference here -- a padding, a letter spacing, a
 * font fallback that resolves differently -- shows up as text drifting away
 * from the caret, so there is exactly one copy of it.
 */
const SHARED_TEXT =
  'px-3 py-2.5 font-mono text-[13px] leading-relaxed tracking-normal whitespace-pre';

export interface CodeEditorProps extends Omit<ComponentProps<'textarea'>, 'value' | 'onChange'> {
  value: string;
  onValueChange: (next: string) => void;
  language: CodeLanguage;
  /** Applied to the wrapper, so callers size the editor as one box. */
  className?: string;
}

export function CodeEditor({
  value,
  onValueChange,
  language,
  className,
  rows = 8,
  ref,
  ...props
}: CodeEditorProps) {
  const highlight = useRef<HTMLPreElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  /**
   * Two refs on one element: this component needs it to sync the scroll, and
   * the caller needs it too -- "find in body" scrolls the textarea to a match.
   * Taken as a prop and merged rather than left to the spread below, which
   * would silently replace the internal one and break the colours' alignment
   * the moment anyone passed a ref.
   */
  const attach = (node: HTMLTextAreaElement | null) => {
    input.current = node;
    if (typeof ref === 'function') ref(node);
    else if (ref !== null && ref !== undefined) ref.current = node;
  };

  const tokens = useMemo(() => tokenize(language, value), [language, value]);

  // Kept in step on every scroll, and re-synced whenever the text changes: an
  // edit near the end of a long line moves the caret, and the browser scrolls
  // the textarea to follow it without telling us.
  const sync = () => {
    const from = input.current;
    const to = highlight.current;
    if (from === null || to === null) return;
    to.scrollTop = from.scrollTop;
    to.scrollLeft = from.scrollLeft;
  };
  useLayoutEffect(sync, [value]);

  return (
    <div
      className={cn(
        'relative isolate resize-y overflow-hidden rounded-lg bg-sunk shadow-edge',
        'focus-within:shadow-[inset_0_0_0_1px_var(--color-gold)]',
        className,
      )}
    >
      {/* Behind, and never interactive: the textarea above owns every event. */}
      <pre
        ref={highlight}
        aria-hidden
        className={cn(
          SHARED_TEXT,
          'pointer-events-none absolute inset-0 m-0 overflow-hidden text-ink select-none',
        )}
      >
        {tokens.map((token, index) => (
          // Index keys: this list is rebuilt wholesale on every keystroke and
          // has no identity to preserve between renders.
          <span key={index} className={TOKEN_CLASS[token.kind]}>
            {token.text}
          </span>
        ))}
        {/* Keeps a trailing newline's empty line from collapsing, so the last
            line of the coloured layer lines up with the last line of text. */}
        {'​'}
      </pre>

      <textarea
        ref={attach}
        value={value}
        rows={rows}
        wrap="off"
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        onChange={(event) => {
          onValueChange(event.target.value);
        }}
        onScroll={sync}
        className={cn(
          SHARED_TEXT,
          'relative block h-full w-full resize-none overflow-auto bg-transparent',
          // The text itself is invisible; the caret and the selection are not.
          'text-transparent caret-ink [-webkit-text-fill-color:transparent]',
          'placeholder:text-ink-label placeholder:[-webkit-text-fill-color:var(--color-ink-label)]',
          'focus:outline-none',
        )}
        {...props}
      />
    </div>
  );
}
