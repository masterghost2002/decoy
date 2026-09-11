import { Play } from 'lucide-react';

import { Button } from '@/ui/components/ui/button';
import { cn } from '@/ui/lib/utils';
import type { PageScope } from '@/ui/lib/scope';

export interface PageScopeStripProps {
  enabled: boolean;
  scope: PageScope;
  /** Drives the paused copy, which names the consequence in rules. */
  ruleCount: number;
  /** Popup only: the tab view has no single page to be scoped to. */
  hasScope: boolean;
  onResume: () => void;
}

/**
 * The second of the four "is it working" signals, at popup distance. It reports
 * what happened on this page in the last few seconds rather than what is
 * configured somewhere, which is the difference between evidence and a claim.
 *
 * Always rendered, at one fixed height, whatever it has to say. Pausing,
 * resuming and the first request arriving all change the words inside this
 * strip and nothing about the geometry around it -- the list below never moves.
 * A second bar appearing underneath to hold "Resume mocking" is exactly the
 * kind of shift this avoids, so that button lives in here.
 */
export function PageScopeStrip({
  enabled,
  scope,
  ruleCount,
  hasScope,
  onResume,
}: PageScopeStripProps) {
  return (
    <div
      className={cn(
        // A single fixed height is the whole point: this strip is the one thing
        // between the header and the tabs, and it must not resize.
        'flex h-9 shrink-0 items-center gap-2 border-b px-3.5 font-mono text-[12px]',
        enabled ? 'border-gold/30 bg-wash text-ink-muted' : 'border-hairline bg-sunk text-ink-muted',
      )}
    >
      {enabled ? (
        <ScopeReport scope={scope} hasScope={hasScope} />
      ) : (
        <>
          <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-hairline-strong" />
          {/* Short enough to survive beside the button at 420px. The
              consequence is the part that has to fit, not the grammar. */}
          <span className="min-w-0 truncate">
            {ruleCount === 0
              ? 'Nothing intercepted — no rules yet.'
              : `Nothing intercepted — ${String(ruleCount)} ${ruleCount === 1 ? 'rule' : 'rules'} inactive.`}
          </span>
          <Button size="sm" variant="primary" className="ml-auto" onClick={onResume}>
            <Play />
            Resume
          </Button>
        </>
      )}
    </div>
  );
}

function ScopeReport({ scope, hasScope }: { scope: PageScope; hasScope: boolean }) {
  if (!hasScope) {
    return (
      <>
        <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-gold" />
        <span className="min-w-0 truncate">Intercepting every tab this profile has open.</span>
      </>
    );
  }

  if (scope.requests === 0) {
    return (
      <>
        <span aria-hidden className="size-[7px] shrink-0 rounded-full bg-hairline-strong" />
        <span className="min-w-0 truncate">
          Watching this tab — reload the page to see its requests.
        </span>
      </>
    );
  }

  return (
    <>
      {/* Pulses while it is working. A still dot cannot tell "working" from
          "configured", which is the entire complaint this answers. */}
      <span aria-hidden className="animate-pulse-dot size-[7px] shrink-0 rounded-full bg-gold" />
      {/* The host truncates and the counts do not: the numbers are the
          evidence, and a long hostname must not push them off a 420px strip. */}
      <span className="tabular flex min-w-0 gap-1">
        <span className="min-w-0 truncate">{scope.host ?? 'this tab'}</span>
        <span className="shrink-0">
          · {scope.requests} request{scope.requests === 1 ? '' : 's'} ·{' '}
          <b className="font-medium text-gold-text">{scope.mocked} mocked</b> · {scope.rulesFired}{' '}
          rule{scope.rulesFired === 1 ? '' : 's'} fired
        </span>
      </span>
    </>
  );
}
