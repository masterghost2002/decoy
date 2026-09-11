import { Bot, Check, Copy, RefreshCw } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogTrigger,
  FullscreenDialogContent,
} from '@/ui/components/ui/dialog';
import { Field } from '@/ui/components/ui/field';
import { Input } from '@/ui/components/ui/input';
import { Switch } from '@/ui/components/ui/switch';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { useAgent } from '@/ui/hooks/useAgent';
import { cn } from '@/ui/lib/utils';

/**
 * Letting an agent drive Decoy.
 *
 * The whole surface is one switch, one port and one token, because that is the
 * whole of the decision. Everything else here is evidence: whether a bridge is
 * actually connected, and the exact block of config to paste, generated with
 * this browser's own token already in it.
 *
 * Three things are deliberate:
 *
 *  - **Off by default, and switched on here.** A socket that lets another
 *    process rewrite what your app sees is not something to enable quietly, and
 *    the side granting permission should be the one holding the secret.
 *  - **The token is shown, not hidden.** It exists to be copied into a config
 *    file. Masking it would make the one thing this panel is for harder, and it
 *    protects nothing: anyone reading this screen can already change the rules.
 *  - **The connection state is live.** "Switched on" is configuration. "A
 *    browser is connected" is the only thing that answers "why isn't it
 *    working?".
 *
 * Deliberately no gold anywhere on this surface. Gold means exactly one thing
 * in this product -- requests are being intercepted -- and an agent being
 * connected is not that. Connected is ink; a refusal is danger.
 */

const STATE_LABEL = {
  off: 'Not running',
  connecting: 'Looking for the bridge',
  connected: 'Connected',
  refused: 'Token rejected',
  error: 'Something went wrong',
} as const;

export function AgentPanel() {
  const { agent, error, setEnabled, setPort, rotate } = useAgent();
  const [copied, setCopied] = useState<string | null>(null);
  const [portDraft, setPortDraft] = useState<string | null>(null);

  const port = agent?.port ?? 0;
  const state = agent?.state ?? 'off';

  const snippet = JSON.stringify(
    {
      mcpServers: {
        decoy: {
          command: 'npx',
          args: ['-y', '@decoy/mcp'],
          env: { DECOY_TOKEN: agent?.token ?? '', DECOY_PORT: String(port) },
        },
      },
    },
    null,
    2,
  );

  const copy = (what: string, value: string) => {
    void navigator.clipboard.writeText(value).then(
      () => {
        setCopied(what);
        setTimeout(() => {
          setCopied(null);
        }, 1600);
      },
      () => {
        setCopied(null);
      },
    );
  };

  return (
    <Dialog>
      <Tooltip label="Let an agent drive Decoy">
        <DialogTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label="Agent control">
            <Bot className={cn(state === 'connected' && 'text-ink')} />
          </Button>
        </DialogTrigger>
      </Tooltip>

      <FullscreenDialogContent title="Agent control">
        <div className="flex flex-col gap-5 p-4">
          <div className="flex items-start justify-between gap-4">
            <div className="max-w-prose">
              <p className="text-ink">
                Let an agent read the traffic log and write rules, so it can mock an endpoint while
                it is writing the code that calls it.
              </p>
              <p className="helper mt-1">
                Decoy connects out to a bridge you run locally — nothing can reach this browser that
                it did not choose to connect to. Off unless you switch it on.
              </p>
            </div>
            <Switch
              tone="ink"
              checked={agent?.enabled ?? false}
              onCheckedChange={setEnabled}
              aria-label={agent?.enabled === true ? 'Stop agent control' : 'Allow agent control'}
            />
          </div>

          <div
            className="flex items-center gap-2 rounded-lg border border-hairline-strong px-3 py-2"
            role="status"
            aria-live="polite"
          >
            <span
              className={cn(
                'size-2 rounded-full',
                state === 'connected' && 'bg-ink',
                state === 'connecting' && 'bg-ink-muted',
                (state === 'refused' || state === 'error') && 'bg-danger',
                state === 'off' && 'bg-hairline-strong',
              )}
            />
            <span className="font-mono text-xs">{STATE_LABEL[state]}</span>
            {agent?.detail !== undefined && agent.detail.length > 0 ? (
              <span className="helper">{agent.detail}</span>
            ) : null}
          </div>

          <Field
            label="Port"
            hint="The bridge listens here, on this machine only. Change it if something else already has 8787."
          >
            {(controlId) => (
              <Input
                id={controlId}
                type="number"
                min={1024}
                max={65535}
                className="w-32"
                aria-label="Bridge port"
                value={portDraft ?? String(port)}
                onChange={(event) => {
                  setPortDraft(event.target.value);
                }}
                onBlur={() => {
                  const next = Number.parseInt(portDraft ?? '', 10);
                  setPortDraft(null);
                  if (Number.isInteger(next) && next !== port) setPort(next);
                }}
              />
            )}
          </Field>

          <Field
            label="Token"
            hint="The bridge will not run without it, and refuses any browser whose token does not match."
          >
            {(controlId) => (
              <div className="flex items-center gap-2">
                <Input
                  id={controlId}
                  readOnly
                  aria-label="Agent token"
                  className="font-mono text-xs"
                  value={agent?.token ?? ''}
                  onFocus={(event) => {
                    event.target.select();
                  }}
                />
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Copy the token"
                  onClick={() => {
                    copy('token', agent?.token ?? '');
                  }}
                >
                  {copied === 'token' ? <Check /> : <Copy />}
                </Button>
                <Tooltip label="Replace the token. Anything using the old one stops working.">
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label="Generate a new token"
                    onClick={rotate}
                  >
                    <RefreshCw />
                  </Button>
                </Tooltip>
              </div>
            )}
          </Field>

          <Field
            label="Agent configuration"
            hint="Paste this into your MCP client's config — Claude Code, Claude Desktop, Cursor. The token is already in it."
          >
            {() => (
              <div className="flex items-start gap-2">
                <pre className="min-w-0 flex-1 overflow-x-auto rounded-lg border border-hairline bg-sunk p-3 font-mono text-[11px] leading-relaxed">
                  {snippet}
                </pre>
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label="Copy the agent configuration"
                  onClick={() => {
                    copy('snippet', snippet);
                  }}
                >
                  {copied === 'snippet' ? <Check /> : <Copy />}
                </Button>
              </div>
            )}
          </Field>

          {error !== null ? <p className="text-xs text-danger">{error}</p> : null}

          <div className="flex justify-end">
            <DialogClose asChild>
              <Button variant="secondary">Done</Button>
            </DialogClose>
          </div>
        </div>
      </FullscreenDialogContent>
    </Dialog>
  );
}
