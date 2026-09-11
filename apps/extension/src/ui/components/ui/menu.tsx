import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import type { ComponentProps } from 'react';

import { getPortalContainer } from '@/ui/lib/roots';
import { cn } from '@/ui/lib/utils';

/**
 * Row actions live here rather than behind hover. A `⋯` that is always visible
 * costs one glyph of space and makes duplicate, reorder and delete reachable
 * without opening the rule first.
 */
export const Menu = DropdownMenuPrimitive.Root;
export const MenuTrigger = DropdownMenuPrimitive.Trigger;

export function MenuContent({
  className,
  align = 'end',
  sideOffset = 4,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal container={getPortalContainer()}>
      <DropdownMenuPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        // `collisionPadding` matters more than usual: the popup viewport is
        // only 420 x 600 and a menu must never be clipped off the edge.
        collisionPadding={8}
        className={cn(
          'z-50 min-w-[9.5rem] overflow-hidden rounded-xl bg-surface p-1 shadow-pop',
          'shadow-[inset_0_0_0_1px_var(--hairline),var(--shadow-pop)]',
          'data-[state=open]:animate-in data-[state=closed]:animate-out',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function MenuItem({
  className,
  destructive = false,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Item> & { destructive?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(
        'flex cursor-pointer select-none items-center gap-2 rounded-lg px-2 py-1.5 text-[14px] outline-none',
        '[&_svg]:size-3.5 [&_svg]:shrink-0',
        destructive
          ? 'text-danger data-[highlighted]:bg-danger data-[highlighted]:text-white'
          : 'text-ink data-[highlighted]:bg-sunk',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A menu row that toggles rather than fires. The check sits in a reserved gutter
 * so the labels stay on one left edge whether or not anything is selected --
 * rows that shift sideways as you tick them are unreadable at speed.
 */
export function MenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      className={cn(
        'flex cursor-pointer items-center gap-2 rounded-lg py-1.5 pr-2 pl-7 text-[14px] outline-none select-none',
        'relative text-ink data-[highlighted]:bg-sunk',
        'data-[disabled]:pointer-events-none data-[disabled]:opacity-40',
        className,
      )}
      {...props}
    >
      <DropdownMenuPrimitive.ItemIndicator className="absolute left-2 flex items-center">
        <Check aria-hidden className="size-3.5 text-gold-text" />
      </DropdownMenuPrimitive.ItemIndicator>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function MenuSeparator({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      className={cn('my-1 h-px bg-hairline', className)}
      {...props}
    />
  );
}

export function MenuLabel({
  className,
  ...props
}: ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return <DropdownMenuPrimitive.Label className={cn('eyebrow px-2 py-1', className)} {...props} />;
}
