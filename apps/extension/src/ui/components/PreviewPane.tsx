import { resolveAction, type MockRule } from '@mocksmith/core';
import { useMemo } from 'react';

import { UrlMatchTester } from '@/ui/components/rule-editor/UrlMatchTester';
import { planToWire } from '@/ui/lib/wire';

export interface PreviewPaneProps {
  /** The draft, not the saved rule: the preview has to track what you are typing. */
  rule: MockRule;
  rules: MockRule[];
}

/**
 * The literal response this rule will synthesize, rendered as the wire format
 * it actually becomes.
 *
 * A form describes what a response *will* be; this shows it. It also fills the
 * third of the tab view that used to be empty, which is why the match tester
 * lives here on wide surfaces -- both of these answer "did I get this right?"
 * and belong next to each other.
 *
 * The heading is pinned and only the body below it scrolls, so this pane holds
 * still while the form beside it is being filled in.
 */
export function PreviewPane({ rule, rules }: PreviewPaneProps) {
  const preview = useMemo(() => describe(rule), [rule]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-paper">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline bg-surface px-3.5 py-2">
        <h2 className="eyebrow flex-1">Preview</h2>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-y-auto p-3.5">
        <pre className="overflow-x-auto rounded-xl bg-sunk p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink shadow-ring">
          {preview.wire}
        </pre>
        <p className="helper">{preview.note}</p>

        <UrlMatchTester rule={rule} rules={rules} />
      </div>
    </div>
  );
}

interface Described {
  wire: string;
  note: string;
}

function describe(rule: MockRule): Described {
  const plan = resolveAction(rule.action);

  if (plan.kind === 'handler') {
    /*
     * There is nothing to render. The whole point of a handler is that the
     * response is a function of the request, so a preview would have to invent
     * a request to show one -- and a made-up preview of real code is worse than
     * no preview: it is a second answer that can disagree with the first.
     *
     * What is useful here is the contract, which is fixed.
     */
    const lines = [
      'function (req, res, next, store) {',
      '  req  method url path query params headers cookies body',
      '  res  status() set() json() text() send() stream() fail()',
      '  next() — let the rules below this one answer instead',
      '  store — survives between requests, for the life of the page',
      '}',
    ];
    return {
      wire: lines.join('\n'),
      note: `The response depends on the request, so there is nothing to show until one arrives. The handler gets ${String(plan.timeoutMs)}ms to answer, and its console output goes to the page's own console. ${delayNote(plan.delayMs, 'The answer is then held back')}`,
    };
  }

  if (plan.kind === 'passthrough') {
    return {
      wire: '(the real response, untouched)',
      note: 'Matching requests reach the network and come back with whatever the server said. Nothing is synthesized.',
    };
  }

  if (plan.kind === 'networkError') {
    return {
      wire: planToWire(plan),
      note: delayNote(plan.delayMs, 'The failure is delivered'),
    };
  }

  if (plan.kind === 'stream') {
    const count = plan.chunks.length;
    if (count === 0) {
      return {
        wire: planToWire(plan),
        note: `No chunks, so the response has no body. ${delayNote(plan.delayMs, 'The head arrives')}`,
      };
    }

    const pace =
      plan.intervalMs === 0
        ? `${String(count)} ${count === 1 ? 'chunk' : 'chunks'} back to back`
        : `${String(count)} ${count === 1 ? 'chunk' : 'chunks'}, one every ${String(plan.intervalMs)}ms`;
    const ending =
      plan.repeat === 0
        ? 'The list repeats until the page stops reading — the stream never closes on its own.'
        : plan.repeat === 1
          ? 'Then the stream closes.'
          : `The list is sent ${String(plan.repeat)} times, then the stream closes.`;

    return {
      wire: planToWire(plan),
      note: `${delayNote(plan.delayMs, 'The head arrives')} Then ${pace}. ${ending}`,
    };
  }

  const bodyNote =
    plan.body === null
      ? rule.action.kind === 'respond' && rule.action.body.type !== 'empty'
        ? `A ${String(plan.status)} response is not allowed to carry a body, so the one on this rule is dropped.`
        : 'No body — the response is headers only.'
      : 'The body is sent exactly as written; invalid JSON is a valid thing to mock.';

  return { wire: planToWire(plan), note: `${bodyNote} ${delayNote(plan.delayMs, 'It arrives')}` };
}

function delayNote(delayMs: number, subject: string): string {
  return delayMs === 0 ? `${subject} immediately.` : `${subject} after ${String(delayMs)}ms.`;
}
