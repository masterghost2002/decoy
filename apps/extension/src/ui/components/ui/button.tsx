import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,box-shadow,color] duration-[120ms] disabled:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Ink-filled, not gold. A soft-gold primary claims the interception
        // colour, and in dark theme it renders a muddy olive that reads as
        // disabled. Ink on paper is unambiguous in both themes and leaves gold
        // to mean one thing. One primary per surface.
        primary: 'bg-ink text-paper hover:bg-ink/86 disabled:bg-sunk disabled:text-ink-label',
        secondary:
          'bg-surface text-ink shadow-edge hover:bg-sunk disabled:text-ink-label disabled:shadow-ring',
        ghost: 'text-ink-muted hover:bg-sunk hover:text-ink disabled:text-ink-label',
        danger: 'bg-danger text-white hover:brightness-110 disabled:opacity-50',
      },
      size: {
        sm: 'h-[29px] px-3 text-[12.5px] [&_svg]:size-4',
        md: 'h-[33px] px-4 text-[13.5px] [&_svg]:size-[17px]',
        icon: 'size-8 [&_svg]:size-[17px]',
        // 28px of ink inside a 32px hit area, so it clears the target floor
        // without punching a hole in a dense row.
        'icon-sm': 'hit-28 size-7 [&_svg]:size-4',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
);

export type ButtonProps = ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    /** Render the child element instead of a button, keeping the styles. */
    asChild?: boolean;
  };

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  ...props
}: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      className={cn(buttonVariants({ variant, size }), className)}
      {...(asChild ? {} : { type })}
      {...props}
    />
  );
}

export { buttonVariants };
