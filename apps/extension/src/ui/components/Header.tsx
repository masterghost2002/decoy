import {
  ChevronsRight,
  ExternalLink,
  Monitor,
  Moon,
  PictureInPicture2,
  Sun,
  X,
} from 'lucide-react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import { AgentPanel } from '@/ui/components/AgentPanel';
import { Button } from '@/ui/components/ui/button';
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from '@/ui/components/ui/menu';
import { Switch } from '@/ui/components/ui/switch';
import { Tooltip } from '@/ui/components/ui/tooltip';
import { openFullPage } from '@/ui/lib/messaging';
import { THEME_CHOICES, type ThemeChoice } from '@/ui/hooks/useTheme';
import { cn } from '@/ui/lib/utils';

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const THEME_LABEL: Record<ThemeChoice, string> = {
  system: 'Match the system',
  light: 'Light',
  dark: 'Dark',
};

export interface HeaderProps {
  enabled: boolean;
  onToggle: (next: boolean) => void;
  enabledRuleCount: number;
  showOpenInTab: boolean;
  theme: ThemeChoice;
  onThemeChange: (next: ThemeChoice) => void;
  /** Popup only: drops the floating panel into the page behind it. */
  onOpenPanel?: () => void;
  /** Floating panel only: takes it back off the page. */
  onClose?: () => void;
  /**
   * Floating panel only: folds it away to a button at the edge of the page.
   * Distinct from closing, which discards the panel entirely -- collapsing
   * keeps where it was, how big it was, and which rule was open.
   */
  onCollapse?: () => void;
  /** Floating panel only: makes this bar the thing you drag the panel by. */
  onDragPointerDown?: (event: ReactPointerEvent<HTMLElement>) => void;
}

export function Header({
  enabled,
  onToggle,
  enabledRuleCount,
  showOpenInTab,
  theme,
  onThemeChange,
  onOpenPanel,
  onClose,
  onCollapse,
  onDragPointerDown,
}: HeaderProps) {
  const ThemeIcon = THEME_ICON[theme];
  const draggable = onDragPointerDown !== undefined;

  return (
    <header
      onPointerDown={(event) => {
        // Only the bar itself drags. Starting a drag from the master switch
        // would mean the panel lurched every time somebody paused mocking.
        if (event.target instanceof Element && event.target.closest('button, input, [role]')) {
          return;
        }
        onDragPointerDown?.(event);
      }}
      className={cn(
        'flex shrink-0 items-center gap-2.5 border-b border-hairline bg-surface px-3.5 py-2.5',
        draggable && 'cursor-grab touch-none select-none active:cursor-grabbing',
      )}
    >
      {/* The real toolbar icon, so the surface and the browser chrome match. */}
      <img
        src={chrome.runtime.getURL('icons/icon-32.png')}
        alt=""
        aria-hidden
        draggable={false}
        className="size-[18px] rounded"
      />
      <h1 className="text-[16.5px] font-semibold tracking-[-0.02em]">Decoy</h1>

      <div className="flex-1" />

      {/* Spelled out, because colour alone must not carry it -- and gold as
       *type* has to come from the typographic gold, not the fill gold. */}
      <span
        className={cn('eyebrow flex items-center gap-1.5', enabled && 'text-gold-text')}
        aria-live="polite"
      >
        {enabled ? <span aria-hidden className="size-[7px] rounded-full bg-gold" /> : null}
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

      <AgentPanel />

      <Menu>
        <MenuTrigger asChild>
          <Button size="icon-sm" variant="ghost" aria-label={`Theme: ${THEME_LABEL[theme]}`}>
            <ThemeIcon />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuLabel>Theme</MenuLabel>
          {THEME_CHOICES.map((choice) => {
            const Icon = THEME_ICON[choice];
            return (
              <MenuItem
                key={choice}
                onSelect={() => {
                  onThemeChange(choice);
                }}
                className={cn(choice === theme && 'bg-wash')}
              >
                <Icon />
                {THEME_LABEL[choice]}
              </MenuItem>
            );
          })}
        </MenuContent>
      </Menu>

      {onOpenPanel !== undefined ? (
        <Tooltip label="Float over this page">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onOpenPanel}
            aria-label="Open Decoy as a floating panel over this page"
          >
            <PictureInPicture2 />
          </Button>
        </Tooltip>
      ) : null}

      {showOpenInTab ? (
        <Tooltip label="Open in a full tab">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={openFullPage}
            aria-label="Open Decoy in a full tab"
          >
            <ExternalLink />
          </Button>
        </Tooltip>
      ) : null}

      {onCollapse !== undefined ? (
        <Tooltip label="Collapse out of the way">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onCollapse}
            aria-label="Collapse the Decoy panel"
          >
            <ChevronsRight />
          </Button>
        </Tooltip>
      ) : null}

      {onClose !== undefined ? (
        <Tooltip label="Close the panel">
          <Button
            size="icon-sm"
            variant="ghost"
            onClick={onClose}
            aria-label="Close the Decoy panel"
          >
            <X />
          </Button>
        </Tooltip>
      ) : null}
    </header>
  );
}
