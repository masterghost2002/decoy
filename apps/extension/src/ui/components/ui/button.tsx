import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';

import { cn } from '@/ui/lib/utils';

const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-full font-medium transition-[background-color,box-shadow,color] disabled:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        // Soft gold rather than saturated: it reads as the primary action
        // without competing with the gold that means "actively intercepting".
        primary:
          'bg-gold-soft text-gold-ink shadow-raised hover:brightness-[0.97] disabled:bg-sunk disabled:text-ink-faint disabled:shadow-none',
        secondary:
          'bg-surface text-ink shadow-[inset_0_0_0_1px_var(--hairline),var(--shadow-soft)] hover:bg-sunk disabled:text-ink-faint disabled:shadow-ring',
        ghost: 'text-ink-muted hover:bg-sunk hover:text-ink disabled:text-ink-faint',
        danger: 'bg-danger text-white hover:brightness-110 disabled:opacity-50',
      },
      size: {
        sm: 'h-7 px-2.5 text-xs [&_svg]:size-3.5',
        md: 'h-8 px-3.5 text-[13px] [&_svg]:size-4',
        icon: 'size-7 [&_svg]:size-4',
        'icon-sm': 'size-6 [&_svg]:size-3.5',
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
