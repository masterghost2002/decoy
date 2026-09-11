import { ExternalLink } from 'lucide-react';

import { Button } from '@/ui/components/ui/button';
import { Switch } from '@/ui/components/ui/switch';
import { openFullPage } from '@/ui/lib/messaging';
import { cn } from '@/ui/lib/utils';

export interface HeaderProps {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  enabledRuleCount: number;
  showOpenInTab: boolean;
}

export function Header({ enabled, onToggle, enabledRuleCount, showOpenInTab }: HeaderProps) {
  return (
    <header className="flex items-center gap-2.5 border-b border-hairline bg-surface px-3.5 py-2.5">
      {/* The real toolbar icon, so the surface and the browser chrome match. */}
      <img
        src={chrome.runtime.getURL('icons/icon-32.png')}
        alt=""
        aria-hidden
        className="size-[18px] rounded"
      />
      <h1 className="text-[15px] font-semibold tracking-[-0.02em]">Mocksmith</h1>

      <div className="flex-1" />

      {/* The state is spelled out, because colour alone must not carry it. */}
      <span
        className={cn('eyebrow', enabled ? 'text-warn' : 'text-ink-faint')}
        aria-live="polite"
      >
        {enabled
          ? enabledRuleCount === 0
            ? 'On · no rules'
            : `On · ${String(enabledRuleCount)} active`
          : 'Paused'}
      </span>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={enabled ? 'Pause all mocking' : 'Resume mocking'}
      />

      {showOpenInTab ? (
        <Button
          size="icon-sm"
          variant="ghost"
          onClick={openFullPage}
          aria-label="Open Mocksmith in a full tab"
          title="Open in a full tab"
        >
          <ExternalLink />
        </Button>
      ) : null}
    </header>
  );
}
