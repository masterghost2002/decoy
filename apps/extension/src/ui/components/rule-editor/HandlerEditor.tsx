import { MAX_HANDLER_TIMEOUT_MS, type MockRule } from '@mocksmith/core';
import { Play } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Button } from '@/ui/components/ui/button';
import { Field, Label } from '@/ui/components/ui/field';
import {
  FileLoader,
  dropRing,
  useFileDrop,
  type LoadedFile,
} from '@/ui/components/ui/file-loader';
import { HelpPopover } from '@/ui/components/ui/help-popover';
import { Input, Textarea } from '@/ui/components/ui/input';
import { useToast } from '@/ui/components/ui/toast';
import { useHandlerRunner } from '@/ui/hooks/useHandlerRunner';
import { planToWire } from '@/ui/lib/wire';
import { cn } from '@/ui/lib/utils';

export interface HandlerEditorProps {
  /** The draft rule, so a test run uses the code currently on screen. */
  rule: MockRule;
  code: string;
  timeoutMs: number;
  onChangeCode: (next: string) => void;
  onChangeTimeout: (next: number) => void;
}

/**
 * The code editor for a handler rule, and a way to run it.
 *
 * The runner is not a nicety. Code that only executes when the app happens to
 * make the right request is code you debug by reloading someone else's page
 * and watching the network panel; being able to type a url and see the response
 * is the difference between this being usable and being a black box. It runs
 * in the same sandbox the interceptor uses, so what appears here is produced by
 * the code path that will answer the real request -- never by a second
 * implementation that can disagree with it.
 */
export function HandlerEditor({
  rule,
  code,
  timeoutMs,
  onChangeCode,
  onChangeTimeout,
}: HandlerEditorProps) {
  const toast = useToast();
  const runner = useHandlerRunner();
  const [method, setMethod] = useState('GET');
  const [url, setUrl] = useState('');
  const [body, setBody] = useState('');

  // The obvious thing to test against is the pattern the rule already matches.
  useEffect(() => {
    setUrl((current) => (current.length > 0 ? current : suggestUrl(rule)));
  }, [rule]);

  // An edited handler has not been tested, and showing the old result beside
  // new code is the one thing a runner must never do.
  useEffect(() => {
    runner.reset();
  }, [code, runner.reset]);

  const loadFile = (file: LoadedFile) => {
    onChangeCode(file.text);
    toast.show(`Handler loaded from ${file.name}`);
  };
  const drop = useFileDrop(loadFile, (message) => {
    toast.show(message);
  });

  return (
    <>
      <div className="flex flex-col gap-1.5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="mocksmith-handler-code">Handler</Label>
            <HelpPopover title="What a handler is given" side="bottom">
              <p>
                The body of a function called with <code>req</code>, <code>res</code>,{' '}
                <code>next</code> and <code>store</code>. Pasting a whole{' '}
                <code>function handler(req, res)</code> works too.
              </p>
              <p>
                <b>req</b> — <code>method</code>, <code>url</code>, <code>path</code>,{' '}
                <code>host</code>, <code>query</code>, <code>queryAll</code>, <code>params</code>,{' '}
                <code>headers</code>, <code>cookies</code>, <code>body</code>,{' '}
                <code>transport</code>.
              </p>
              <p>
                <b>res</b> — <code>status()</code>, <code>set()</code>, <code>delay()</code>,{' '}
                <code>json()</code>, <code>text()</code>, <code>send()</code>,{' '}
                <code>sendStatus()</code>, <code>stream(chunks, &#123;format, every, repeat&#125;)</code>,{' '}
                <code>fail()</code>, <code>passthrough()</code>.
              </p>
              <p>
                Returning a plain value sends it as json. Returning nothing —{' '}
                or <code>next()</code> — hands the request to the rules below this one, which is
                how a handler at the top of the list behaves like middleware.
              </p>
              <p>
                <b>params</b> comes from the url pattern: named groups in <code>regex</code> mode,{' '}
                <code>0</code>, <code>1</code>… for each <code>*</code> in <code>wildcard</code>{' '}
                mode.
              </p>
              <p>
                <b>store</b> is a plain object that survives between requests for the life of the
                page — a counter, a fake database, a token you just issued.
              </p>
              <p>
                <code>await</code> is available. <code>console.log</code> goes to the console of
                the page being mocked.
              </p>
            </HelpPopover>
          </div>
          <div className="flex items-center gap-1.5">
            <FileLoader
              onLoad={loadFile}
              onError={(message) => {
                toast.show(message);
              }}
              accept=".js,.mjs,.ts,.txt,text/javascript"
              label="Load .js"
            />
          </div>
        </div>

        <div {...drop.handlers} className={cn('flex flex-col rounded-lg', dropRing(drop.over))}>
          <Textarea
            id="mocksmith-handler-code"
            rows={14}
            value={code}
            onChange={(event) => {
              onChangeCode(event.target.value);
            }}
            placeholder={'return res.status(200).json({ ok: true });'}
            className="min-h-[12rem]"
          />
        </div>

        <p className="helper max-w-[62ch]">
          Runs in a sandboxed extension frame, not in the page: a site's content security policy
          cannot stop it, and it cannot touch the page or the extension. It has no network access —
          a handler synthesizes a response rather than fetching one.
        </p>
      </div>

      <Field
        label="Timeout (ms)"
        hint="If the handler has not answered by then it is stopped, and the request gets a 500 naming the reason."
        className="w-[9rem] shrink-0"
      >
        {(id) => (
          <Input
            id={id}
            type="number"
            min={1}
            max={MAX_HANDLER_TIMEOUT_MS}
            value={timeoutMs}
            className="tabular font-mono"
            onChange={(event) => {
              const parsed = Number.parseInt(event.target.value, 10);
              onChangeTimeout(
                Number.isNaN(parsed) ? 1 : Math.min(Math.max(1, parsed), MAX_HANDLER_TIMEOUT_MS),
              );
            }}
          />
        )}
      </Field>

      <div className="flex flex-col gap-1.5">
        <Label>Try it</Label>
        <div className="flex flex-wrap items-end gap-1.5">
          <Input
            value={method}
            aria-label="Test request method"
            onChange={(event) => {
              setMethod(event.target.value.toUpperCase());
            }}
            className="w-[5.5rem] font-mono text-[13px] uppercase"
            autoComplete="off"
          />
          <Input
            value={url}
            aria-label="Test request url"
            placeholder="/api/users?page=2"
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            className="min-w-[12rem] flex-1 font-mono text-[13px]"
            autoComplete="off"
          />
          <Button
            variant="primary"
            onClick={() => {
              runner.run(rule, { method, url, body });
            }}
            disabled={runner.outcome.kind === 'running'}
          >
            <Play />
            Run
          </Button>
        </div>

        <Textarea
          rows={2}
          value={body}
          aria-label="Test request payload"
          placeholder='{"note":"the payload this request sends, if any"}'
          onChange={(event) => {
            setBody(event.target.value);
          }}
        />

        <TestResult outcome={runner.outcome} />
      </div>
    </>
  );
}

function TestResult({ outcome }: { outcome: ReturnType<typeof useHandlerRunner>['outcome'] }) {
  if (outcome.kind === 'idle') {
    return (
      <p className="helper">
        Nothing has been run yet. Headers and cookies are empty here — only the method, url and
        payload above are sent.
      </p>
    );
  }

  if (outcome.kind === 'running') {
    return <p className="helper">Running…</p>;
  }

  if (outcome.kind === 'declined') {
    return (
      <p className="text-[12.5px] leading-snug text-ink-muted">
        The handler declined this request, so the first matching rule <b>below</b> this one would
        answer it — or the real network, if there is none.
      </p>
    );
  }

  if (outcome.kind === 'failed') {
    return (
      <div className="flex flex-col gap-1">
        <pre className="overflow-x-auto rounded-xl bg-sunk p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-danger shadow-ring">
          {outcome.message}
        </pre>
        <p className="helper">
          A real request would get a 500 carrying this message, rather than reaching the network.
        </p>
      </div>
    );
  }

  return (
    <pre className="overflow-x-auto rounded-xl bg-sunk p-2.5 font-mono text-[12px] leading-relaxed whitespace-pre-wrap text-ink shadow-ring">
      {planToWire(outcome.plan)}
    </pre>
  );
}

/**
 * A url worth testing against, taken from the rule itself. A `contains` pattern
 * is usually a path and can be used as-is; the anchored and pattern modes are
 * not urls at all, so they get a plausible one instead of a broken one.
 */
function suggestUrl(rule: MockRule): string {
  const { mode, value } = rule.matcher.url;
  if (value.trim().length === 0) return '/api/users';
  if (mode === 'contains' || mode === 'equals' || mode === 'startsWith') return value;
  return '/api/users';
}
