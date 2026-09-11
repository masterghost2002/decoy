import { ExternalLink } from 'lucide-react';

import { Switch } from '@/ui/components/ui/switch';
import { Button } from '@/ui/components/ui/button';
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
    <header className="flex items-center gap-2 border-b border-border bg-card px-3 py-2">
      {/* The real toolbar icon, so the surface and the browser chrome match. */}
      <img
        src={chrome.runtime.getURL('icons/icon-32.png')}
        alt=""
        aria-hidden
        className="size-5 rounded"
      />
      <h1 className="text-sm font-semibold tracking-tight">Mocksmith</h1>

      <div className="flex-1" />

      <span
        className={cn(
          'text-xs font-medium',
          enabled ? 'text-foreground' : 'text-muted-foreground',
        )}
      >
        {/* The word matters: colour alone must not carry "is it on". */}
        {enabled
          ? enabledRuleCount === 0
            ? 'On, no active rules'
            : `On, ${String(enabledRuleCount)} active`
          : 'Paused'}
      </span>
      <Switch
        checked={enabled}
        onCheckedChange={onToggle}
        aria-label={enabled ? 'Pause all mocking' : 'Resume mocking'}
      />

      {showOpenInTab ? (
        <Button
          size="icon"
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
